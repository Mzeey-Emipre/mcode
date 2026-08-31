/**
 * GitHub Copilot SDK provider adapter.
 * Implements IAgentProvider using @github/copilot-sdk with callback-based session events.
 *
 * SDK event model:
 *   session.on(eventType, handler) → handler receives typed SessionEvent payloads
 *   session.send({ prompt }) → triggers the agentic loop
 *   session.idle → signals the turn is complete
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { injectable, inject } from "tsyringe";
import which from "which";
import * as NodeEvents from "node:events";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession, ModelInfo } from "@github/copilot-sdk";
import { discoverCopilotAgents, COPILOT_DEFAULT_AGENTS } from "./copilot-agent-discovery.js";
import {
  resolveCopilotCli,
  createNodeResolverIO,
  formatCopilotNotFoundMessage,
  formatCopilotUpgradeMessage,
  type CopilotCliResolution,
} from "./copilot-cli-resolver.js";
import { logger } from "@mcode/shared";
import { SettingsService } from "../../../settings/settings-service.js";
import { EnvService } from "../../../../runtime/environment/env-service.js";
import { InternalThreadControlMcpRuntime } from "../../../thread-control/index.js";
import { buildMcodeInstructionPlan, renderMcodeInstructions } from "@mcode/thread-orchestration";
import { JobObject } from "../../../../runtime/process/containment/job-object.js";
import { SessionRuntime } from "../../runtime/session-runtime.js";
import type { ProtocolAdapter, SpawnArgs, SpawnResult } from "../../runtime/session-runtime.js";
import { CleanForker } from "../../../handoff/index.js";
import {
  browserAutomationPermissionCapability,
  type BrowserAutomationCredentialMetadata,
  BrowserAutomationSessionLease,
  type BrowserAutomationSessionLeaseScope,
  type BrowserAutomationSessionLeaseStage,
} from "../../../browser-automation/index.js";
import type {
  IAgentProvider,
  ISessionEvictable,
  SessionForker,
  TurnRequest,
  ProviderId,
  ReasoningLevel,
  AgentEvent,
  AttachmentMeta,
  ProviderModelInfo,
  QuotaCategory,
  ProviderUsageInfo,
  CompletionOptions,
  ProviderIdentity,
} from "@mcode/contracts";
import type { ProviderHostPorts } from "@mcode/providers";
import {
  AgentEventType,
  BROWSER_AUTOMATION_OPERATION_METADATA,
  providerRuntimeEvent,
} from "@mcode/contracts";
import type { InternalThreadControlMcpHttpConnection } from "../../../thread-control/index.js";
import {
  CanonicalLiveEventPublisher,
  type CanonicalLiveEventRouting,
} from "../../composition/canonical-live-event-publisher.js";

/** Promisified execFile used to retrieve the gh auth token. */
const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const SIDE_CHANNEL_TIMEOUT_MS = 120_000;

/** Builds the Copilot SDK's remote HTTP MCP configuration for one provider session. */
export function buildCopilotInternalMcpServers(
  connection: InternalThreadControlMcpHttpConnection,
): Record<string, { type: "http"; url: string; headers: Record<string, string>; tools: ["*"] }> {
  return {
    [connection.name]: {
      type: "http",
      url: connection.url,
      headers: connection.headers,
      tools: ["*"],
    },
  };
}

/** Preserves existing Copilot user instructions while appending runtime guidance. */
export function composeCopilotSystemMessage(
  userInstructions: string | undefined,
  runtimeInstructions: string,
): { content: string } {
  return {
    content: [userInstructions, runtimeInstructions]
      .filter((value): value is string => Boolean(value && value.trim()))
      .join("\n\n"),
  };
}

function transientHandoffError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = "ETIMEDOUT";
  return err;
}

/**
 * Reads user-level Copilot instructions from `~/.copilot/copilot-instructions.md`.
 * Returns `undefined` if the file does not exist or cannot be read.
 */
function readUserInstructions(): string | undefined {
  try {
    return NodeFS.readFileSync(NodePath.join(NodeOS.homedir(), ".copilot", "copilot-instructions.md"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Returns user-level Copilot skill directories to pass to the SDK session.
 * Currently resolves `~/.copilot/skills` if it exists.
 */
function userSkillDirectories(): string[] {
  const dir = NodePath.join(NodeOS.homedir(), ".copilot", "skills");
  return NodeFS.existsSync(dir) ? [dir] : [];
}

/** Maps raw Copilot quota snapshot keys to human-readable labels. */
const QUOTA_LABELS: Record<string, string> = {
  premium_interactions: "Premium usage",
  chat: "Chat",
  completions: "Completions",
};

/** Shape of a single quota snapshot entry from the Copilot SDK assistant.usage event. */
interface QuotaSnapshot {
  isUnlimitedEntitlement?: boolean;
  entitlementRequests?: number;
  usedRequests?: number;
  remainingPercentage?: number;
  resetDate?: string;
  overage?: number;
  overageAllowedWithExhaustedQuota?: boolean;
  usageAllowedWithExhaustedQuota?: boolean;
}

/**
 * Converts a raw Copilot quota snapshot map into an array of normalized QuotaCategory objects
 * suitable for the QuotaUpdate AgentEvent.
 */
export function normalizeQuotaSnapshots(
  snapshots: Record<string, QuotaSnapshot>,
): QuotaCategory[] {
  return Object.entries(snapshots).map(([key, snap]) => {
    // A category is limited only when the API provides a positive entitlement value
    // and does not mark it as unlimited. Categories returned with no entitlement
    // data (entitlementRequests = 0 or absent) default to unlimited so we never
    // display a misleading 0/0.
    const hasLimit = (snap.entitlementRequests ?? 0) > 0;
    const isUnlimited = snap.isUnlimitedEntitlement ?? !hasLimit;
    return {
      label: QUOTA_LABELS[key] ?? key,
      used: snap.usedRequests ?? 0,
      total: hasLimit ? snap.entitlementRequests! : null,
      remainingPercent: (snap.remainingPercentage ?? 100) / 100,
      resetDate: snap.resetDate,
      isUnlimited,
    };
  });
}

/** Infer vendor group from model ID prefix for UI section headers. */
function inferModelGroup(modelId: string): string | undefined {
  const group = MODEL_GROUPS.find(({ names }) => names.some((name) => modelId === name || modelId.startsWith(`${name}-`)));
  return group?.label;
}

const MODEL_GROUPS = [
  { label: "OpenAI", names: ["gpt", "o1", "o3", "o4"] },
  { label: "Anthropic", names: ["claude"] },
  { label: "Google", names: ["gemini"] },
  { label: "xAI", names: ["grok"] },
] as const;

/** Names of built-in Copilot session modes, derived from COPILOT_DEFAULT_AGENTS. */
const BUILTIN_MODE_NAMES = new Set<"interactive" | "plan" | "autopilot">(
  COPILOT_DEFAULT_AGENTS.map((a) => a.name as "interactive" | "plan" | "autopilot"),
);

/**
 * Per-session state owned by the {@link SessionRuntime}. Holds the live Copilot
 * SDK session plus the turn-active flag the runtime's busy guard reads. Copilot
 * exposes no native busy signal, so `turnActive` is the provider-maintained
 * substitute: set true while a turn runs, false when it settles.
 */
interface CopilotSessionState {
  sessionId: string;
  session: CopilotSession;
  lastUsedAt: number;
  /**
   * True while a turn is in flight. The SDK has no busy signal, so the provider
   * toggles this in `runTurn` to give the runtime's idle-eviction guard a real
   * busy check (the drift this migration converges).
   */
  turnActive: boolean;
  /** Non-secret browser credential lifecycle metadata for this main session. */
  browserCredential?: BrowserAutomationCredentialMetadata;
  /** Lease handle owning the browser credential for this main session. */
  browserLeaseId?: string;
  /** Workspace fixed to this SDK session at creation. */
  workspaceId: string;
  /** Browser permission class fixed to this SDK session at creation. */
  browserPermissionCapability: "observe" | "interact" | "privileged";
}

interface StagedCopilotTurn {
  message: string;
  model?: string;
  copilotAgent?: string;
  turnExecutionId: string;
}

interface PendingBrowserAccess {
  scope: BrowserAutomationSessionLeaseScope;
  stage: BrowserAutomationSessionLeaseStage;
}

interface CopilotSendMessageParams {
  sessionId: string;
  message: string;
  cwd: string;
  model: string;
  fallbackModel?: string;
  resume: boolean;
  permissionMode: string;
  attachments?: AttachmentMeta[];
  reasoningLevel?: ReasoningLevel;
  copilotAgent?: string;
}

type CopilotClientOptions = NonNullable<ConstructorParameters<typeof CopilotClient>[0]>;

/** GitHub Copilot SDK adapter implementing IAgentProvider with callback-based event mapping. */
@injectable()
export class CopilotProvider extends NodeEvents.EventEmitter implements IAgentProvider, ISessionEvictable, ProtocolAdapter<CopilotSessionState> {
  readonly id: ProviderId = "copilot";
  readonly supportsCompletion = true;
  readonly sessionForkOnResume = "clean" as const;
  readonly maxInputCharactersPerTurn = 16_000;
  /** Path B forker; calls this provider's throwaway SDK side channel. */
  readonly forker: SessionForker = new CleanForker(this);

  private client: CopilotClient | null = null;
  private lastCliPath: string | undefined;
  /** Last CLI resolution; surfaced as a user-facing error when not-found. */
  private lastResolution: CopilotCliResolution | null = null;
  /** Cached result of `which("node")` so we don't re-probe PATH on every rebuild. */
  private cachedNodePath: string | null | undefined;
  /** Owns the session pool, idle eviction (now with a real busy guard via `isBusy`), and JobObject/kill. */
  private readonly runtime: SessionRuntime<CopilotSessionState>;
  private sdkSessionIds = new Map<string, string>();
  /** Canonical routing retained while the SDK keeps a pooled session alive. */
  private readonly canonicalRoutings = new Map<string, CanonicalLiveEventRouting>();
  /** Serializes canonical event submission when the adapter runs in the server composition. */
  private readonly canonicalEventPublisher: CanonicalLiveEventPublisher | undefined;
  /**
   * Session IDs for which a stop was requested before the session was created.
   * Checked after session creation; if found the session is torn down immediately.
   */
  private pendingStops = new Set<string>();
  /**
   * Per-turn payload carried from `sendTurn` to `spawn` so a freshly spawned
   * session can run its first turn. The runtime's `acquire` only returns the
   * state, so the turn message and agent routing are staged here keyed by
   * sessionId.
   */
  private pendingSpawnTurns = new Map<string, StagedCopilotTurn>();
  /** Browser scope staged only until a fresh normal SDK session starts. */
  private pendingBrowserAccess = new Map<string, PendingBrowserAccess>();
  /** Serialises setup of overlapping sends so staged browser handles cannot be overwritten. */
  private sendLocks = new Map<string, Promise<void>>();
  /** Serialises concurrent refreshClient() calls so only one rebuild runs at a time. */
  private clientStartLock: Promise<void> = Promise.resolve();

  private modelCache: ProviderModelInfo[] | null = null;
  private modelCacheTimestamp = 0;
  /** Avoid hammering the Copilot SDK on every call - results are stable within a session. */
  private static readonly MODEL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
    @inject("JobObject") private readonly jobObject: JobObject,
    @inject(EnvService) private readonly envService: EnvService,
    @inject(BrowserAutomationSessionLease)
    private readonly browserAutomationLease: BrowserAutomationSessionLease = new BrowserAutomationSessionLease(),
    @inject(InternalThreadControlMcpRuntime)
    private readonly threadControlMcp: InternalThreadControlMcpRuntime = undefined as never,
    @inject("ProviderHostPorts")
    private readonly host?: ProviderHostPorts,
  ) {
    super();
    this.canonicalEventPublisher = this.host?.events
      ? new CanonicalLiveEventPublisher(this.id, this.host.events)
      : undefined;
    this.runtime = new SessionRuntime<CopilotSessionState>(this, {
      jobObject: this.jobObject,
      envService: this.envService,
    });
  }

  /**
   * One-shot text completion using an ephemeral Copilot session.
   * Creates a temporary session, sends the prompt, collects the response
   * text from SDK callbacks, then tears down the session.
   */
  async complete(_prompt: string, _model: string, _cwd: string, _options?: CompletionOptions): Promise<string> {
    const prompt = _prompt;
    const model = _model;
    const cwd = _cwd;
    await this.refreshClient();
    const notFoundMessage = this.cliNotFoundMessage();
    if (notFoundMessage) throw new Error(notFoundMessage);
    const client = this.client;
    if (!client) {
      throw new Error("Copilot client not available");
    }

    const userInstructions = readUserInstructions();
    const skillDirs = userSkillDirectories();
    const session = await client.createSession({
      onPermissionRequest: approveAll,
      model: model || undefined,
      workingDirectory: cwd,
      enableConfigDiscovery: true,
      ...(skillDirs.length > 0 && { skillDirectories: skillDirs }),
      ...(userInstructions && { systemMessage: { content: userInstructions } }),
    });

    const unsubscribers: Array<() => void> = [];

    try {
      let messageText = "";
      let deltaText = "";

      const turnPromise = new Promise<void>((resolve, reject) => {
        unsubscribers.push(
          session.on("assistant.message_delta", (event: { data: { deltaContent: string } }) => {
            deltaText += event.data.deltaContent;
          }),
        );

        unsubscribers.push(
          session.on("assistant.message", (event: { data: { content: string } }) => {
            if (event.data.content) messageText = event.data.content;
          }),
        );

        unsubscribers.push(
          session.on("session.error", (event: { data: { message: string } }) => {
            reject(new Error(event.data.message));
          }),
        );

        unsubscribers.push(
          session.on("session.idle", () => {
            resolve();
          }),
        );
      });

      const COMPLETE_TIMEOUT_MS = 60_000;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Copilot complete() timed out after 60 seconds")),
          COMPLETE_TIMEOUT_MS,
        );
      });

      await session.send({ prompt });

      try {
        await Promise.race([turnPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }

      const text = messageText || deltaText;
      if (!text) throw new Error("Copilot returned no text content");
      return text.trim();
    } finally {
      for (const unsub of unsubscribers) unsub();
      await session.disconnect().catch((err: unknown) =>
        logger.debug("CopilotProvider: error disconnecting ephemeral session", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  /**
   * Run a handoff prompt in a throwaway Copilot session.
   * The pooled parent session is left untouched; the SDK session is disconnected.
   */
  async runSideChannelQuery(args: {
    parentThreadId: string;
    parentSdkSessionId: string;
    prompt: string;
    abortSignal?: AbortSignal;
    conversationHistory?: string;
    cwd: string;
  }): Promise<string> {
    const { parentThreadId, prompt, abortSignal, conversationHistory, cwd } = args;
    if (abortSignal?.aborted) throw transientHandoffError("Copilot side-channel query aborted before start");

    await this.refreshClient();
    const notFoundMessage = this.cliNotFoundMessage();
    if (notFoundMessage) throw transientHandoffError(notFoundMessage);
    const client = this.client;
    if (!client) throw transientHandoffError("Copilot client not available");

    const session = await this.createSideChannelSession(client, cwd, parentThreadId);
    const sideChannelPrompt = this.buildSideChannelPrompt(prompt, conversationHistory);

    try {
      return await this.awaitSideChannelResponse(session, sideChannelPrompt, abortSignal);
    } finally {
      await this.disconnectSideChannelSession(session, parentThreadId);
    }
  }

  private async createSideChannelSession(
    client: CopilotClient,
    cwd: string,
    parentThreadId: string,
  ): Promise<CopilotSession> {
    const userInstructions = readUserInstructions();
    const skillDirs = userSkillDirectories();
    try {
      return await client.createSession({
        onPermissionRequest: approveAll,
        workingDirectory: cwd,
        enableConfigDiscovery: true,
        ...(skillDirs.length > 0 && { skillDirectories: skillDirs }),
        ...(userInstructions && { systemMessage: { content: userInstructions } }),
      });
    } catch (err) {
      throw transientHandoffError(
        `Copilot side-channel could not create isolated session for parent thread ${parentThreadId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private buildSideChannelPrompt(prompt: string, conversationHistory?: string): string {
    if (!conversationHistory) return prompt;
    return `Conversation history up to the fork point:\n\n${conversationHistory}\n\n---\n\n${prompt}`;
  }

  private async awaitSideChannelResponse(
    session: CopilotSession,
    prompt: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const unsubscribers: Array<() => void> = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let messageText = "";
    let deltaText = "";

    try {
      return await new Promise<string>((resolve, reject) => {
        const finish = (value: string): void => {
          abortSignal?.removeEventListener("abort", abortDuringTurn);
          clearTimeout(timeout);
          resolve(value);
        };
        const rejectTransient = (message: string): void => {
          abortSignal?.removeEventListener("abort", abortDuringTurn);
          clearTimeout(timeout);
          reject(transientHandoffError(message));
        };
        const abortDuringTurn = (): void => {
          void session.disconnect().catch(() => {});
          rejectTransient("Copilot side-channel query aborted");
        };

        timeout = setTimeout(
          () => rejectTransient("Copilot side-channel query timed out"),
          SIDE_CHANNEL_TIMEOUT_MS,
        );
        abortSignal?.addEventListener("abort", abortDuringTurn, { once: true });

        unsubscribers.push(
          session.on("assistant.message_delta", (event: { data: { deltaContent: string } }) => {
            deltaText += event.data.deltaContent;
          }),
        );
        unsubscribers.push(
          session.on("assistant.message", (event: { data: { content: string; phase?: string } }) => {
            if (event.data.phase === "thinking") return;
            if (event.data.content) messageText = event.data.content;
          }),
        );
        unsubscribers.push(
          session.on("session.error", (event: { data: { message: string } }) => {
            rejectTransient(event.data.message);
          }),
        );
        unsubscribers.push(
          session.on("session.idle", () => {
            const text = (messageText || deltaText).trim();
            if (!text) {
              rejectTransient("Copilot side-channel query returned empty output");
              return;
            }
            finish(text);
          }),
        );

        void session.send({ prompt })
          .catch((err: unknown) => rejectTransient(err instanceof Error ? err.message : String(err)));
      });
    } finally {
      clearTimeout(timeout);
      for (const unsub of unsubscribers) unsub();
    }
  }

  private async disconnectSideChannelSession(session: CopilotSession, parentThreadId: string): Promise<void> {
    await session.disconnect().catch((err: unknown) =>
      logger.debug("Copilot side-channel disconnect failed", { parentThreadId, error: String(err) }),
    );
  }

  /** Fetch available models from the Copilot SDK, with a 10-minute TTL cache. */
  async listModels(): Promise<ProviderModelInfo[]> {
    const cachedModels = this.getCachedModels();
    if (cachedModels) return cachedModels;
    if (!await this.refreshClientForModels()) return [];

    const client = this.getClientForModels("Copilot client not available");
    if (!client) return [];

    const result = this.toProviderModels(await this.listSdkModels(client));
    this.modelCache = result;
    this.modelCacheTimestamp = Date.now();
    return result;
  }

  private getCachedModels(): ProviderModelInfo[] | null {
    const isFresh = this.modelCache &&
      (Date.now() - this.modelCacheTimestamp) < CopilotProvider.MODEL_CACHE_TTL_MS;
    return isFresh ? this.modelCache : null;
  }

  private async refreshClientForModels(): Promise<boolean> {
    try {
      await this.refreshClient();
      return true;
    } catch (error: unknown) {
      if (!this.errorMessage(error).includes("Could not find @github/copilot")) throw error;
      logger.warn("CopilotProvider: @github/copilot not installed, returning empty model list");
      return false;
    }
  }

  private getClientForModels(errorMessage: string): CopilotClient | null {
    if (this.client) return this.client;
    if (this.lastResolution?.source === "not-found") return null;
    throw new Error(errorMessage);
  }

  private async listSdkModels(client: CopilotClient): Promise<ModelInfo[]> {
    try {
      return await client.listModels();
    } catch (error: unknown) {
      const message = this.errorMessage(error);
      if (!message.includes("not connected")) throw error;

      logger.warn("CopilotProvider: listModels connection lost, reconnecting", { error: message });
      this.resetClientAndModelCache();
      await this.refreshClient();
      const freshClient = this.getClientForModels("Copilot client not available after reconnect");
      return freshClient ? freshClient.listModels() : [];
    }
  }

  private toProviderModels(sdkModels: ModelInfo[]): ProviderModelInfo[] {
    return sdkModels.map((m) => ({
      id: m.id,
      name: m.name,
      group: inferModelGroup(m.id),
      contextWindow: m.capabilities?.limits?.max_context_window_tokens,
      supportsVision: m.capabilities?.supports?.vision,
      supportsReasoning: m.capabilities?.supports?.reasoningEffort,
      supportedReasoningEfforts: m.supportedReasoningEfforts as ProviderModelInfo["supportedReasoningEfforts"],
      defaultReasoningEffort: m.defaultReasoningEffort as ProviderModelInfo["defaultReasoningEffort"],
      policy: m.policy ? { state: m.policy.state as "enabled" | "disabled" | "unconfigured" } : undefined,
      multiplier: m.billing?.multiplier,
    }));
  }

  private resetClientAndModelCache(): void {
    this.client = null;
    this.modelCache = null;
    this.modelCacheTimestamp = 0;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** Return current usage/quota state by fetching from account.getQuota(). */
  async getUsage(): Promise<ProviderUsageInfo> {
    await this.refreshClient();
    if (this.lastResolution?.source === "not-found" || !this.client) {
      throw new Error("Copilot client unavailable");
    }
    const result = await this.client.rpc.account.getQuota();
    const categories = result?.quotaSnapshots
      ? normalizeQuotaSnapshots(result.quotaSnapshots)
      : [];
    return { providerId: "copilot", quotaCategories: categories };
  }

  /**
   * Rebuild the CopilotClient when the CLI path setting changes.
   *
   * Uses a promise-based mutex (`clientStartLock`) so that concurrent callers
   * wait for the in-flight startup to finish instead of stomping on each
   * other (one call stopping a client that another is mid-start on).
   */
  private refreshClient(): Promise<void> {
    this.clientStartLock = this.clientStartLock
      .catch(() => {})
      .then(() => this.doRefreshClient());
    return this.clientStartLock;
  }

  private async doRefreshClient(): Promise<void> {
    const settings = await this.settingsService.get();
    const configuredCliPath = settings.provider.cli.copilot?.trim() || undefined;
    if (this.canReuseClient(configuredCliPath)) return;

    await this.stopCurrentClient();
    const options = await this.createClientOptions(configuredCliPath);
    if (!options) return;

    await this.startClient(options, configuredCliPath);
  }

  private canReuseClient(configuredCliPath: string | undefined): boolean {
    return configuredCliPath === this.lastCliPath &&
      this.client !== null &&
      this.client.getState() === "connected";
  }

  private async stopCurrentClient(): Promise<void> {
    if (!this.client) return;
    await this.client.stop().catch((err) =>
      logger.warn("CopilotProvider: error stopping old client", { error: String(err) }),
    );
    this.resetClientAndModelCache();
  }

  private async createClientOptions(configuredCliPath: string | undefined): Promise<CopilotClientOptions | undefined> {
    const options: CopilotClientOptions = {
      env: { ...this.envService.getEnv() },
      cliArgs: ["--no-auto-update"],
    };
    const resolution = this.resolveConfiguredCli(options, configuredCliPath);
    if (resolution === false) return undefined;

    await this.configureElectronNode(options, configuredCliPath);
    await this.addGithubToken(options);
    return options;
  }

  private resolveConfiguredCli(
    options: CopilotClientOptions,
    configuredCliPath: string | undefined,
  ): CopilotCliResolution | false | undefined {
    if (!configuredCliPath) {
      this.lastResolution = null;
      return undefined;
    }

    const resolution = resolveCopilotCli(
      { configuredPath: configuredCliPath },
      createNodeResolverIO(this.envService.getEnv(), this.requireHostRuntime().platform),
    );
    this.lastResolution = resolution;
    if (resolution.source === "not-found") {
      logger.warn("CopilotProvider: CLI not found", { message: resolution.message });
      this.lastCliPath = configuredCliPath;
      return false;
    }

    options.cliPath = resolution.entry;
    logger.info("CopilotProvider: resolved configured CLI", {
      source: resolution.source,
      version: resolution.version ?? "unknown",
    });
    return resolution;
  }

  private async configureElectronNode(options: CopilotClientOptions, configuredCliPath: string | undefined): Promise<void> {
    if (!this.usesBundledCliInElectron(configuredCliPath)) return;
    const nodePath = await this.resolveElectronNodePath();
    if (!nodePath) return;

    const nodeDir = NodePath.dirname(nodePath);
    const separator = this.requireHostRuntime().platform === "win32" ? ";" : ":";
    const existingPath = options.env?.PATH ?? options.env?.Path ?? "";
    const pathValue = existingPath ? `${nodeDir}${separator}${existingPath}` : nodeDir;
    options.env = {
      ...options.env,
      PATH: pathValue,
      ...(this.requireHostRuntime().platform === "win32" ? { Path: pathValue } : {}),
    };
  }

  private usesBundledCliInElectron(configuredCliPath: string | undefined): boolean {
    return Boolean(process.versions.electron) && !configuredCliPath;
  }

  private async resolveElectronNodePath(): Promise<string | null> {
    if (this.cachedNodePath !== undefined) return this.cachedNodePath;

    this.cachedNodePath = await which("node", { nothrow: true });
    if (!this.cachedNodePath) {
      logger.warn("CopilotProvider: node not found in PATH; SDK will use process.execPath (electron)");
    }
    return this.cachedNodePath;
  }

  private async addGithubToken(options: CopilotClientOptions): Promise<void> {
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"], {
        timeout: 5000,
        windowsHide: true,
      });
      const token = stdout.trim();
      if (token) options.githubToken = token;
    } catch (err) {
      logger.debug("CopilotProvider: gh auth token unavailable, falling back to SDK auth", {
        error: this.errorMessage(err),
      });
    }
  }

  private async startClient(options: CopilotClientOptions, configuredCliPath: string | undefined): Promise<void> {
    const client = new CopilotClient(options);
    if (!await this.startSdkClient(client, configuredCliPath)) return;

    this.client = client;
    this.lastCliPath = configuredCliPath;
    logger.info("CopilotProvider: client started", { state: client.getState() });
  }

  private async startSdkClient(client: CopilotClient, configuredCliPath: string | undefined): Promise<boolean> {
    try {
      await this.startSdkClientWithElectronNode(client, configuredCliPath);
      return true;
    } catch (err: unknown) {
      const message = this.errorMessage(err);
      if (!message.includes("--headless") && !message.includes("unknown option")) throw err;

      this.lastResolution = {
        source: "not-found",
        entry: null,
        version: null,
        message: formatCopilotUpgradeMessage(this.lastResolution?.version ?? null),
      };
      this.lastCliPath = configuredCliPath;
      logger.warn("CopilotProvider: CLI too old for SDK", { message: this.lastResolution.message });
      return false;
    }
  }

  private async startSdkClientWithElectronNode(client: CopilotClient, configuredCliPath: string | undefined): Promise<void> {
    if (!this.usesBundledCliInElectron(configuredCliPath) || !this.cachedNodePath) {
      await client.start();
      return;
    }

    const originalExecPath = process.execPath;
    process.execPath = this.cachedNodePath;
    try {
      await client.start();
    } finally {
      process.execPath = originalExecPath;
    }
  }

  /** Returns the resolver install message when the CLI could not be resolved. */
  private cliNotFoundMessage(): string | null {
    return this.lastResolution?.source === "not-found" ? this.lastResolution.message : null;
  }

  /** Strip the "mcode-" session prefix to derive the threadId used in emitted AgentEvents. */
  private toThreadId(sessionId: string): string {
    return sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
  }

  /** Cached context window limit from the last session.usage_info event, keyed by sessionId. */
  private contextWindowBySession = new Map<string, number>();

  /** Start or continue a session by sending a message via the Copilot SDK. When `copilotAgent` is provided, routes the session to the appropriate built-in mode or custom agent before sending. */
  async sendTurn(req: TurnRequest<"copilot">): Promise<void> {
    const routing = this.rememberCanonicalRouting(req);
    const previousSend = this.sendLocks.get(req.sessionId) ?? Promise.resolve();
    let releaseSend!: () => void;
    const currentSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    this.sendLocks.set(req.sessionId, currentSend);
    await previousSend;

    // `resumeFrom` defined ⇒ resume that SDK session; undefined ⇒ fresh.
    if (req.resumeFrom !== undefined) {
      this.sdkSessionIds.set(req.sessionId, req.resumeFrom);
    }
    const browserScope: BrowserAutomationSessionLeaseScope = {
      providerId: this.id,
      providerSessionId: req.resumeFrom ?? req.sessionId,
      mcodeSessionId: req.sessionId,
      threadId: req.threadId,
      workspaceId: req.workspaceId,
      permissionCapability: browserAutomationPermissionCapability(
        req.permissionMode,
        req.interactionMode,
      ),
    };
    const browserAccess = {
      scope: browserScope,
      stage: this.browserAutomationLease.stage(browserScope),
    };
    this.pendingBrowserAccess.set(req.sessionId, browserAccess);
    const params = {
      sessionId: req.sessionId,
      message: req.message,
      cwd: req.cwd,
      model: req.model,
      fallbackModel: req.fallbackModel,
      resume: req.resumeFrom !== undefined,
      permissionMode: req.permissionMode,
      attachments: req.attachments,
      reasoningLevel: req.reasoningLevel,
      copilotAgent: req.providerOptions.agent,
    };
    try {
      await this.doSendMessage(params, routing);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("CopilotProvider sendMessage error", {
        sessionId: params.sessionId,
        error: msg,
      });

      // Translate SDK-level CLI launch failures into actionable user messages.
      const threadId = this.toThreadId(params.sessionId);

      if (msg.includes("CLI server exited")) {
        // The @github/copilot process died - discard the dead client so
        // refreshClient() rebuilds it on the next attempt.
        this.client = null;
        this.modelCache = null;
        this.modelCacheTimestamp = 0;
        const userMsg =
          "GitHub Copilot CLI exited unexpectedly.\n\n" +
          "Ensure you are authenticated: run `gh auth login` and confirm you have an active GitHub Copilot subscription.";
        this.publishTurnEvent(routing, req.sessionId, { type: "error", threadId, error: userMsg } satisfies AgentEvent);
        this.publishTurnEvent(routing, req.sessionId, {
          type: "ended",
          threadId,
          turnExecutionId: routing.executionId,
        } satisfies AgentEvent);
        await this.waitForCanonicalExecution(routing.executionId);
        return;
      }

      if (msg.includes("Could not find @github/copilot")) {
        const userMsg = formatCopilotNotFoundMessage(
          undefined,
          createNodeResolverIO(this.envService.getEnv(), this.requireHostRuntime().platform),
        );
        this.publishTurnEvent(routing, req.sessionId, { type: "error", threadId, error: userMsg } satisfies AgentEvent);
        this.publishTurnEvent(routing, req.sessionId, {
          type: "ended",
          threadId,
          turnExecutionId: routing.executionId,
        } satisfies AgentEvent);
        await this.waitForCanonicalExecution(routing.executionId);
        return;
      }

      throw e;
    } finally {
      const currentBrowserAccess = this.pendingBrowserAccess.get(req.sessionId);
      if (currentBrowserAccess === browserAccess) {
        this.browserAutomationLease.release(browserAccess.stage.leaseId);
        this.pendingBrowserAccess.delete(req.sessionId);
      }
      releaseSend();
      if (this.sendLocks.get(req.sessionId) === currentSend) this.sendLocks.delete(req.sessionId);
    }
  }

  private async doSendMessage(params: CopilotSendMessageParams, routing: CanonicalLiveEventRouting): Promise<void> {
    await this.refreshClient();

    const { sessionId, message, copilotAgent } = params;
    const threadId = this.toThreadId(sessionId);
    const browserAccess = this.pendingBrowserAccess.get(sessionId);
    if (await this.emitCliResolutionError(sessionId, threadId, routing)) return;

    const existing = await this.getCompatibleSession(sessionId, browserAccess?.scope);
    const state = await this.acquireTurnSession(params, threadId, routing, browserAccess);
    this.completeBrowserAccessAfterAcquire(sessionId, browserAccess, Boolean(existing));
    this.runtime.recordUsage(sessionId);

    if (this.stopRequestedBeforeTurn(sessionId)) return;

    state.lastUsedAt = Date.now();
    if (existing) {
      await this.applyCopilotAgent(state.session, sessionId, copilotAgent, true);
    }
    void this.runTurn(sessionId, threadId, state.session, message, routing);
  }

  private async emitCliResolutionError(
    sessionId: string,
    threadId: string,
    routing: CanonicalLiveEventRouting,
  ): Promise<boolean> {
    if (this.lastResolution?.source !== "not-found") return false;

    this.publishTurnEvent(routing, sessionId, {
      type: "error",
      threadId,
      error: this.lastResolution.message,
    } satisfies AgentEvent);
    this.publishTurnEvent(routing, sessionId, {
      type: "ended",
      threadId,
      turnExecutionId: routing.executionId,
    } satisfies AgentEvent);
    await this.waitForCanonicalExecution(routing.executionId);
    return true;
  }

  private async getCompatibleSession(
    sessionId: string,
    browserScope: BrowserAutomationSessionLeaseScope | undefined,
  ): Promise<CopilotSessionState | undefined> {
    const existing = this.runtime.get(sessionId);
    if (!existing || !this.needsBrowserSessionReplacement(existing, browserScope)) return existing;

    this.refreshExpiredBrowserLease(existing);
    await this.runtime.stop(sessionId);
    return undefined;
  }

  private needsBrowserSessionReplacement(
    state: CopilotSessionState,
    browserScope: BrowserAutomationSessionLeaseScope | undefined,
  ): boolean {
    if (!browserScope || !this.browserAutomationLease.isConfigured()) return false;
    if (state.workspaceId !== browserScope.workspaceId) return true;
    if (state.browserPermissionCapability !== browserScope.permissionCapability) return true;
    return this.hasInvalidBrowserCredential(state);
  }

  private hasInvalidBrowserCredential(state: CopilotSessionState): boolean {
    const credential = state.browserCredential;
    if (!credential) return false;
    if (credential.expiresAt <= Date.now()) return true;
    return state.browserLeaseId !== undefined && !this.browserAutomationLease.isActive(state.browserLeaseId);
  }

  private refreshExpiredBrowserLease(state: CopilotSessionState): void {
    const credential = state.browserCredential;
    const leaseId = state.browserLeaseId;
    if (!credential || !leaseId || credential.expiresAt > Date.now()) return;
    if (this.browserAutomationLease.isActive(leaseId)) this.browserAutomationLease.refresh(leaseId);
  }

  private async acquireTurnSession(
    params: CopilotSendMessageParams,
    threadId: string,
    routing: CanonicalLiveEventRouting,
    browserAccess: PendingBrowserAccess | undefined,
  ): Promise<CopilotSessionState> {
    this.pendingSpawnTurns.set(params.sessionId, {
      message: params.message,
      model: params.model,
      copilotAgent: params.copilotAgent,
      turnExecutionId: routing.executionId,
    });
    try {
      const state = await this.runtime.acquire({
        sessionId: params.sessionId,
        threadId,
        cwd: params.cwd,
        permissionMode: params.permissionMode,
        resumeFrom: params.resume ? this.sdkSessionIds.get(params.sessionId) : undefined,
      });
      this.pendingSpawnTurns.delete(params.sessionId);
      return state;
    } catch (error) {
      this.pendingSpawnTurns.delete(params.sessionId);
      this.releasePendingBrowserAccess(params.sessionId, browserAccess);
      throw error;
    }
  }

  private completeBrowserAccessAfterAcquire(
    sessionId: string,
    browserAccess: PendingBrowserAccess | undefined,
    reusedSession: boolean,
  ): void {
    if (reusedSession && browserAccess) {
      this.browserAutomationLease.release(browserAccess.stage.leaseId);
    }
    this.pendingBrowserAccess.delete(sessionId);
  }

  private releasePendingBrowserAccess(sessionId: string, browserAccess: PendingBrowserAccess | undefined): void {
    if (!browserAccess) return;
    this.browserAutomationLease.release(browserAccess.stage.leaseId);
    this.pendingBrowserAccess.delete(sessionId);
  }

  private stopRequestedBeforeTurn(sessionId: string): boolean {
    if (!this.pendingStops.has(sessionId)) return false;

    void this.runtime.stop(sessionId).catch((err: unknown) =>
      logger.debug("CopilotProvider: stop of pending-stop session failed", {
        sessionId,
        error: this.errorMessage(err),
      }),
    );
    return true;
  }

  private async applyCopilotAgent(
    session: CopilotSession,
    sessionId: string,
    copilotAgent: string | undefined,
    cachedSession: boolean,
  ): Promise<void> {
    if (!copilotAgent) return;

    const cachedSuffix = cachedSession ? " on cached session" : "";
    if (BUILTIN_MODE_NAMES.has(copilotAgent as "interactive" | "plan" | "autopilot")) {
      await session.rpc.mode.set({ mode: copilotAgent as "interactive" | "plan" | "autopilot" });
      logger.info(`CopilotProvider: set built-in mode${cachedSuffix}`, { sessionId, mode: copilotAgent });
      return;
    }

    await session.rpc.agent.select({ name: copilotAgent });
    logger.info(`CopilotProvider: selected custom agent${cachedSuffix}`, { sessionId, agent: copilotAgent });
  }

  /**
   * Spawns a fresh Copilot SDK session: creates (or resumes) the session,
   * applies agent routing, and captures the SDK session id. The first turn is
   * run by the `doSendMessage` caller after the runtime stores this state, so
   * `spawn` does not run it (avoiding a race with the runtime's pool write).
   * Returns an empty `pids` array because the Copilot SDK manages its own
   * subprocess and never exposes the PID; the runtime's JobObject/`taskkill`
   * are therefore best-effort no-ops for Copilot, and teardown is delegated to
   * `session.disconnect()` in {@link close}.
   */
  async spawn(args: SpawnArgs): Promise<SpawnResult<CopilotSessionState>> {
    const { sessionId, threadId, cwd, resumeFrom } = args;
    const client = this.getClientForSpawn();
    const staged = this.pendingSpawnTurns.get(sessionId);
    const browserAccess = this.pendingBrowserAccess.get(sessionId);
    const browserScope = browserAccess?.scope;
    const browserGrant = browserAccess
      ? this.browserAutomationLease.issue(browserAccess.stage)
      : null;

    const routing = this.getStagedRouting(staged);
    const sessionBase = await this.buildSessionOptions({
      sessionId,
      threadId,
      cwd,
      model: staged?.model,
      browserGrant,
    });
    let session: CopilotSession;
    try {
      session = await this.createOrResumeSession(client, sessionId, resumeFrom, sessionBase);
    } catch (error) {
      await this.releaseSpawnResources(sessionId, browserGrant);
      throw error;
    }
    return this.finishSpawn({
      sessionId,
      threadId,
      session,
      copilotAgent: staged?.copilotAgent,
      browserScope,
      browserGrant,
      routing,
    });
  }

  private getClientForSpawn(): CopilotClient {
    if (!this.client) throw new Error("Copilot client not available");
    return this.client;
  }

  private getStagedRouting(staged: StagedCopilotTurn | undefined): CanonicalLiveEventRouting | undefined {
    if (!staged) return undefined;
    return this.canonicalRoutings.get(staged.turnExecutionId);
  }

  private async buildSessionOptions(args: {
    sessionId: string;
    threadId: string;
    cwd: string;
    model: string | undefined;
    browserGrant: ReturnType<BrowserAutomationSessionLease["issue"]> | null;
  }) {
    const customAgents = discoverCopilotAgents(args.cwd, this.requireHostRuntime().platform)
      .filter((agent) => agent.source !== "default")
      .map((agent) => ({
        name: agent.name,
        displayName: agent.displayName,
        description: agent.description,
        prompt: "",
      }));
    const userInstructions = readUserInstructions();
    const skillDirs = userSkillDirectories();
    const internalMcp = await this.threadControlMcp?.createHttpConnection(args.sessionId);
    if (!internalMcp) {
      logger.warn("Copilot thread-control MCP is unavailable; continuing without it", { threadId: args.threadId });
    }

    const runtimeInstructions = renderMcodeInstructions(buildMcodeInstructionPlan({
      sourceThreadId: args.threadId,
      threadControlGranted: Boolean(internalMcp),
      browserAutomationGranted: Boolean(args.browserGrant),
    }));
    return {
      onPermissionRequest: approveAll,
      model: args.model || undefined,
      workingDirectory: args.cwd,
      enableConfigDiscovery: true,
      ...(customAgents.length > 0 && { customAgents }),
      ...(skillDirs.length > 0 && { skillDirectories: skillDirs }),
      systemMessage: composeCopilotSystemMessage(userInstructions, runtimeInstructions),
      mcpServers: {
        ...(internalMcp ? buildCopilotInternalMcpServers(internalMcp) : {}),
        ...(args.browserGrant ? {
          "mcode-browser": {
            type: "http" as const,
            url: args.browserGrant.mcpUrl,
            headers: { Authorization: `Bearer ${args.browserGrant.token}` },
            tools: args.browserGrant.allowedOperations.map(
              (operation) => BROWSER_AUTOMATION_OPERATION_METADATA[operation].mcpName,
            ),
          },
        } : {}),
      },
    };
  }

  private requireHostRuntime(): ProviderHostPorts["runtime"] {
    if (this.host) return this.host.runtime;
    throw new Error("Copilot Provider host runtime is required");
  }

  private async createOrResumeSession(
    client: CopilotClient,
    sessionId: string,
    resumeFrom: string | undefined,
    options: Parameters<CopilotClient["createSession"]>[0],
  ): Promise<CopilotSession> {
    if (!resumeFrom) return client.createSession(options);

    try {
      const session = await client.resumeSession(resumeFrom, options);
      logger.info("Resumed Copilot session", { sessionId, sdkSessionId: resumeFrom });
      return session;
    } catch (err) {
      logger.warn("CopilotProvider: resume failed, starting fresh session", {
        sessionId,
        error: this.errorMessage(err),
      });
      this.sdkSessionIds.delete(sessionId);
      return client.createSession(options);
    }
  }

  private async finishSpawn(args: {
    sessionId: string;
    threadId: string;
    session: CopilotSession;
    copilotAgent: string | undefined;
    browserScope: BrowserAutomationSessionLeaseScope | undefined;
    browserGrant: ReturnType<BrowserAutomationSessionLease["issue"]> | null;
    routing: CanonicalLiveEventRouting | undefined;
  }): Promise<SpawnResult<CopilotSessionState>> {
    try {
      await this.applyCopilotAgent(args.session, args.sessionId, args.copilotAgent, false);
      this.captureSdkSessionId(args.sessionId, args.threadId, args.session, args.routing);
      const state = this.createSessionState(args);
      await this.consumePendingStop(args.sessionId, args.threadId, args.session, args.routing);
      return { state, pids: [] };
    } catch (error) {
      if (args.browserGrant) this.browserAutomationLease.release(args.browserGrant.leaseId);
      await args.session.disconnect().catch(() => {});
      await this.threadControlMcp?.close(args.sessionId);
      this.sdkSessionIds.delete(args.sessionId);
      throw error;
    }
  }

  private captureSdkSessionId(
    sessionId: string,
    threadId: string,
    session: CopilotSession,
    routing: CanonicalLiveEventRouting | undefined,
  ): void {
    const sdkId = session.sessionId;
    if (!sdkId || this.sdkSessionIds.has(sessionId)) return;

    this.sdkSessionIds.set(sessionId, sdkId);
    logger.info("Captured Copilot SDK session ID", { sessionId, sdkId });
    if (!routing) return;

    this.publishTurnEvent(routing, sessionId, {
      type: "system",
      threadId,
      subtype: "sdk_session_id:" + sdkId,
    } satisfies AgentEvent);
  }

  private createSessionState(args: {
    sessionId: string;
    session: CopilotSession;
    browserScope: BrowserAutomationSessionLeaseScope | undefined;
    browserGrant: ReturnType<BrowserAutomationSessionLease["issue"]> | null;
  }): CopilotSessionState {
    return {
      sessionId: args.sessionId,
      session: args.session,
      lastUsedAt: Date.now(),
      turnActive: false,
      workspaceId: args.browserScope?.workspaceId ?? "unknown-workspace",
      browserPermissionCapability: args.browserScope?.permissionCapability ?? "interact",
      ...(args.browserGrant && {
        browserCredential: {
          credentialId: args.browserGrant.credentialId,
          expiresAt: args.browserGrant.expiresAt,
        },
        browserLeaseId: args.browserGrant.leaseId,
      }),
    };
  }

  private async consumePendingStop(
    sessionId: string,
    threadId: string,
    session: CopilotSession,
    routing: CanonicalLiveEventRouting | undefined,
  ): Promise<void> {
    if (!this.pendingStops.has(sessionId)) return;

    logger.info("Pending stop consumed, tearing down new Copilot session", { sessionId });
    void session.disconnect().catch(() => {});
    if (!routing) return;

    this.publishTurnEvent(routing, sessionId, {
      type: AgentEventType.Ended,
      threadId,
      turnExecutionId: routing.executionId,
    } satisfies AgentEvent);
    await this.waitForCanonicalExecution(routing.executionId);
  }

  private async releaseSpawnResources(
    sessionId: string,
    browserGrant: ReturnType<BrowserAutomationSessionLease["issue"]> | null,
  ): Promise<void> {
    if (browserGrant) this.browserAutomationLease.release(browserGrant.leaseId);
    await this.threadControlMcp?.close(sessionId);
  }

  /**
   * Eviction guard: a turn is in flight while `turnActive` is true. Copilot has
   * no native busy signal, so `runTurn` toggles this flag; this converges the
   * busy guard the old TTL-only eviction lacked.
   */
  isBusy(state: CopilotSessionState): boolean {
    return state.turnActive;
  }

  /** Graceful protocol interrupt: disconnect the SDK session. Guarded so a double-disconnect is harmless. */
  async interrupt(state: CopilotSessionState): Promise<void> {
    try {
      await state.session.disconnect();
    } catch (err) {
      logger.debug("CopilotProvider: interrupt disconnect failed (session may already be down)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Provider teardown. Copilot has no separate hard kill; `disconnect()` is the
   * teardown. The runtime calls `interrupt` then `close`, both of which
   * disconnect, so this is guarded against a double-disconnect.
   */
  async close(state: CopilotSessionState): Promise<void> {
    if (state.browserCredential) {
      if (state.browserLeaseId) {
        this.browserAutomationLease.release(state.browserLeaseId);
      } else {
        this.browserAutomationLease.revokeCredential(state.browserCredential.credentialId);
      }
    }
    try {
      await state.session.disconnect();
    } catch (err) {
      logger.debug("CopilotProvider: close disconnect failed (session may already be down)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await this.threadControlMcp?.close(state.sessionId);
  }

  /**
   * Whether a pooled session must be discarded before reuse. The Copilot SDK
   * exposes no reliable per-session liveness getter and the original provider
   * performed no cwd/model/agent staleness check before reuse (a dead session
   * surfaces as `session.error`, which evicts it from the pool). Mirror that:
   * never force-discard here, preserving the prior reuse behavior.
   */
  isStale(_state: CopilotSessionState, _args: { cwd: string; permissionMode: string }): boolean {
    return false;
  }

  /**
   * Register SDK callback handlers, send the message, and resolve when the
   * session becomes idle. All AgentEvents are emitted via EventEmitter so
   * they reach the push channel without blocking sendMessage's return.
   */
  private async runTurn(
    sessionId: string,
    threadId: string,
    session: CopilotSession,
    message: string,
    routing: CanonicalLiveEventRouting,
  ): Promise<void> {
    const emitTurnEvent = (event: AgentEvent): void => {
      this.publishTurnEvent(routing, sessionId, event);
    };
    // Mark the session busy so the runtime's idle-eviction guard spares it for
    // the duration of the turn (Copilot has no native busy signal).
    const turnState = this.runtime.get(sessionId);
    if (turnState) turnState.turnActive = true;

    // Track per-tool start times to derive elapsedSeconds for toolProgress events.
    const toolStartTimes = new Map<string, number>();

    // Accumulate usage data across assistant.usage events for the final TurnComplete.
    // Copilot SDK fires assistant.usage after each model call in an agentic loop,
    // but TurnComplete must fire only once (on session.idle) to prevent premature
    // removal from runningThreadIds in the frontend.
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost: number | undefined;

    const unsubscribers: Array<() => void> = [];

    try {
      const turnPromise = new Promise<void>((resolve) => {
        // assistant.message_delta - streaming text chunk
        unsubscribers.push(
          session.on("assistant.message_delta", (event) => {
            const entry = this.runtime.get(sessionId);
            if (entry) entry.lastUsedAt = Date.now();
            this.runtime.recordUsage(sessionId);

            emitTurnEvent({
              type: "textDelta",
              threadId,
              delta: event.data.deltaContent,
            } satisfies AgentEvent);
          }),
        );

        // assistant.message - final complete assistant response.
        // Phased-output models (e.g. o3, o4-mini, Claude extended thinking) emit
        // one assistant.message per phase. The "thinking" phase carries internal
        // reasoning that must not be saved or shown in the chat. Only the response
        // phase (or messages without an explicit phase) contain user-facing content.
        // Separate assistant.reasoning / assistant.reasoning_delta events carry
        // extended thinking for streaming; those have no handler registered here
        // and are therefore silently ignored.
        unsubscribers.push(
          session.on("assistant.message", (event) => {
            if (event.data.phase === "thinking") return;
            const content = event.data.content;
            if (!content) return;
            emitTurnEvent({
              type: "message",
              threadId,
              content,
              tokens: event.data.outputTokens ?? null,
            } satisfies AgentEvent);
          }),
        );

        // tool.execution_start - assistant is invoking a tool
        unsubscribers.push(
          session.on("tool.execution_start", (event) => {
            const { toolCallId, toolName, arguments: toolArgs } = event.data;
            toolStartTimes.set(toolCallId, Date.now());
            emitTurnEvent({
              type: "toolUse",
              threadId,
              toolCallId,
              toolName,
              toolInput: toolArgs ?? {},
            } satisfies AgentEvent);
          }),
        );

        // tool.execution_complete - tool has finished
        unsubscribers.push(
          session.on("tool.execution_complete", (event) => {
            const { toolCallId, success, result, error } = event.data;
            toolStartTimes.delete(toolCallId);
            emitTurnEvent({
              type: "toolResult",
              threadId,
              toolCallId,
              output: result?.detailedContent ?? result?.content ?? error?.message ?? "",
              isError: !success,
            } satisfies AgentEvent);
          }),
        );

        // tool.execution_progress - heartbeat while a tool runs
        unsubscribers.push(
          session.on("tool.execution_progress", (event) => {
            const { toolCallId } = event.data;
            const startedAt = toolStartTimes.get(toolCallId) ?? Date.now();
            const elapsedSeconds = (Date.now() - startedAt) / 1000;
            // progressMessage is available in data but toolProgress schema only takes elapsedSeconds;
            // log it so operators can see it without altering the contract shape.
            logger.debug("CopilotProvider tool progress", {
              threadId,
              toolCallId,
              progress: event.data.progressMessage,
            });
            emitTurnEvent({
              type: "toolProgress",
              threadId,
              // toolName is not provided in tool.execution_progress; omit gracefully
              toolCallId,
              toolName: "",
              elapsedSeconds,
            } satisfies AgentEvent);
          }),
        );

        // session.usage_info - live context window metrics emitted each turn
        unsubscribers.push(
          session.on("session.usage_info", (event) => {
            const { tokenLimit, currentTokens } = event.data as {
              tokenLimit: number;
              currentTokens: number;
            };
            this.contextWindowBySession.set(sessionId, tokenLimit);
            emitTurnEvent({
              type: "contextEstimate",
              threadId,
              tokensIn: currentTokens,
              contextWindow: tokenLimit,
            } satisfies AgentEvent);
          }),
        );

        // assistant.usage - accumulate token counts across model calls.
        // TurnComplete is deferred to session.idle so the frontend keeps the
        // thread in runningThreadIds for the entire agentic turn.
        unsubscribers.push(
          session.on("assistant.usage", (event) => {
            const {
              inputTokens = 0,
              outputTokens = 0,
              cacheReadTokens = 0,
              cacheWriteTokens = 0,
              cost,
              quotaSnapshots,
            } = event.data;
            // Use latest inputTokens (context grows across calls in a turn)
            totalInputTokens = inputTokens;
            // Accumulate output tokens (each call generates new output)
            totalOutputTokens += outputTokens;
            totalCacheRead += cacheReadTokens;
            totalCacheWrite += cacheWriteTokens;
            if (cost !== undefined) totalCost = (totalCost ?? 0) + cost;

            // Quota updates are safe to emit immediately (they only update
            // usage display, not running state).
            if (quotaSnapshots && typeof quotaSnapshots === "object") {
              emitTurnEvent({
                type: AgentEventType.QuotaUpdate,
                threadId,
                providerId: "copilot",
                categories: normalizeQuotaSnapshots(quotaSnapshots as Record<string, QuotaSnapshot>),
              } satisfies AgentEvent);
            }
          }),
        );

        // session.error - provider-level error; resolve so cleanup runs.
        // Also evict the session entry so the next sendMessage creates a fresh
        // session rather than reusing a potentially dead one. The turn is
        // settling, so clear `turnActive` before stopping so the runtime's
        // busy guard does not block teardown.
        unsubscribers.push(
          session.on("session.error", (event) => {
            emitTurnEvent({
              type: "error",
              threadId,
              error: event.data.message,
            } satisfies AgentEvent);
            const errored = this.runtime.get(sessionId);
            if (errored) errored.turnActive = false;
            this.contextWindowBySession.delete(sessionId);
            void this.runtime.stop(sessionId);
            resolve();
          }),
        );

        // session.compaction_start - context window compaction beginning
        unsubscribers.push(
          session.on("session.compaction_start", () => {
            emitTurnEvent({
              type: "compacting",
              threadId,
              active: true,
            } satisfies AgentEvent);
          }),
        );

        // session.compaction_complete - compaction finished; emit summary if present
        unsubscribers.push(
          session.on("session.compaction_complete", (event) => {
            if (event.data.summaryContent) {
              emitTurnEvent({
                type: "compactSummary",
                threadId,
                summary: event.data.summaryContent,
              } satisfies AgentEvent);
            }
            emitTurnEvent({
              type: "compacting",
              threadId,
              active: false,
            } satisfies AgentEvent);
          }),
        );

        // session.idle - turn is truly complete; emit TurnComplete with
        // accumulated usage data and resolve. This is the single point where
        // the frontend learns the turn ended, preventing premature removal
        // from runningThreadIds during multi-step agentic turns.
        unsubscribers.push(
          session.on("session.idle", () => {
            const contextWindow = this.contextWindowBySession.get(sessionId);
            emitTurnEvent({
              type: AgentEventType.TurnComplete,
              threadId,
              reason: "end_turn",
              costUsd: null,
              tokensIn: totalInputTokens,
              tokensOut: totalOutputTokens,
              contextWindow,
              totalProcessedTokens: totalInputTokens + totalCacheRead + totalCacheWrite + totalOutputTokens,
              cacheReadTokens: totalCacheRead,
              cacheWriteTokens: totalCacheWrite,
              costMultiplier: totalCost,
              providerId: "copilot",
            } satisfies AgentEvent);
            resolve();
          }),
        );
      });

      await session.send({ prompt: message });
      await turnPromise;
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      logger.error("CopilotProvider turn error", { sessionId, error: errorMessage });
            emitTurnEvent({
        type: "error",
        threadId,
        error: errorMessage,
      } satisfies AgentEvent);
    } finally {
      // The turn has settled: clear the busy marker so the runtime's idle
      // eviction (which reads `isBusy` → `turnActive`) can reclaim the session.
      const settled = this.runtime.get(sessionId);
      if (settled) settled.turnActive = false;
      // Deregister all per-turn handlers to prevent memory leaks across turns
      for (const unsub of unsubscribers) {
        unsub();
      }
            emitTurnEvent({
        type: "ended",
        threadId,
        turnExecutionId: routing.executionId,
      } satisfies AgentEvent);
      await this.waitForCanonicalExecution(routing.executionId);
    }
  }

  private rememberCanonicalRouting(req: TurnRequest<"copilot">): CanonicalLiveEventRouting {
    const routing = {
      threadId: req.threadId,
      turnId: req.turnId,
      executionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
    };
    this.canonicalRoutings.set(routing.executionId, routing);
    return routing;
  }

  private publishTurnEvent(
    routing: CanonicalLiveEventRouting,
    sessionId: string,
    event: AgentEvent,
  ): void {
    const runtimeEvent = providerRuntimeEvent({ ...event, turnExecutionId: routing.executionId });
    if (!this.canonicalEventPublisher) {
      this.emit("event", runtimeEvent);
      return;
    }
    this.canonicalEventPublisher.publish(
      routing,
      runtimeEvent,
      this.copilotSessionIdentities(sessionId),
    );
  }

  private copilotSessionIdentities(sessionId: string): ProviderIdentity[] {
    const nativeSessionId = this.sdkSessionIds.get(sessionId);
    if (!nativeSessionId) return [];
    return [{
      providerId: this.id,
      scope: "session",
      value: nativeSessionId,
      provenance: "native",
    }];
  }

  private async waitForCanonicalExecution(executionId: string): Promise<void> {
    const routing = this.canonicalRoutings.get(executionId);
    if (!routing || !this.canonicalEventPublisher) return;
    try {
      await this.canonicalEventPublisher.waitForExecution(routing);
    } catch (error: unknown) {
      logger.error("Copilot canonical event delivery failed", {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.canonicalRoutings.delete(executionId);
    }
  }

  /**
   * Disconnect and remove an active session, or record a pending stop if the
   * session hasn't been created yet. The runtime's `stop` runs `interrupt` →
   * `close` (both disconnect the SDK session, guarded) → hard kill (a no-op for
   * Copilot, whose PID the SDK hides).
   */
  async stopSession(sessionId: string): Promise<void> {
    this.contextWindowBySession.delete(sessionId);
    if (this.runtime.get(sessionId) !== undefined) {
      await this.runtime.stop(sessionId);
    } else {
      this.browserAutomationLease.releaseSession(this.id, sessionId);
      this.pendingStops.add(sessionId);
      this.pendingSpawnTurns.delete(sessionId);
      setTimeout(() => this.pendingStops.delete(sessionId), 10_000);
    }
  }

  /**
   * Force-discard the pooled session so the next sendTurn spawns fresh. Pure
   * pool eviction via the runtime's `stop` (interrupt → close → hard kill),
   * leaving goals and pending permissions intact for the retry turn.
   */
  async discardSession(sessionId: string): Promise<void> {
    if (this.runtime.get(sessionId) === undefined) return;
    await this.runtime.stop(sessionId);
  }

  /** Tear down all sessions, stop the client, and release resources. */
  shutdown(): void {
    void this.runtime.shutdown().catch((err: unknown) =>
      logger.warn("CopilotProvider: runtime shutdown failed", { error: String(err) }),
    );
    this.sdkSessionIds.clear();
    this.pendingSpawnTurns.clear();
    this.sendLocks.clear();
    for (const { stage } of this.pendingBrowserAccess.values()) {
      this.browserAutomationLease.release(stage.leaseId);
    }
    this.pendingBrowserAccess.clear();
    this.contextWindowBySession.clear();

    if (this.client) {
      this.client.stop().catch((err) =>
        logger.warn("CopilotProvider: error stopping client during shutdown", {
          error: String(err),
        }),
      );
      this.client = null;
      this.modelCache = null;
      this.modelCacheTimestamp = 0;
    }

    logger.info("CopilotProvider shutdown complete");
  }
}
