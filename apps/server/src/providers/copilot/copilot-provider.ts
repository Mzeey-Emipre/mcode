/**
 * GitHub Copilot SDK provider adapter.
 * Implements IAgentProvider using @github/copilot-sdk with callback-based session events.
 *
 * SDK event model:
 *   session.on(eventType, handler) → handler receives typed SessionEvent payloads
 *   session.send({ prompt }) → triggers the agentic loop
 *   session.idle → signals the turn is complete
 */

import { execFile } from "child_process";
import { dirname } from "path";
import { promisify } from "util";

import { injectable, inject } from "tsyringe";
import which from "which";
import { EventEmitter } from "events";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession, ModelInfo } from "@github/copilot-sdk";
import { logger } from "@mcode/shared";
import { SettingsService } from "../../services/settings-service.js";
import type {
  IAgentProvider,
  ProviderId,
  ReasoningLevel,
  AgentEvent,
  AttachmentMeta,
  ProviderModelInfo,
  QuotaCategory,
  ProviderUsageInfo,
} from "@mcode/contracts";
import { AgentEventType } from "@mcode/contracts";

/** Promisified execFile used to retrieve the gh auth token. */
const execFileAsync = promisify(execFile);

/** Maps raw Copilot quota snapshot keys to human-readable labels. */
const QUOTA_LABELS: Record<string, string> = {
  premium_interactions: "Premium requests",
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
function normalizeQuotaSnapshots(
  snapshots: Record<string, QuotaSnapshot>,
): QuotaCategory[] {
  return Object.entries(snapshots).map(([key, snap]) => ({
    label: QUOTA_LABELS[key] ?? key,
    used: snap.usedRequests ?? 0,
    total: snap.isUnlimitedEntitlement ? null : (snap.entitlementRequests ?? 0),
    remainingPercent: snap.remainingPercentage ?? 1.0,
    resetDate: snap.resetDate,
    isUnlimited: snap.isUnlimitedEntitlement ?? false,
  }));
}

/** Infer vendor group from model ID prefix for UI section headers. */
function inferModelGroup(modelId: string): string | undefined {
  if (
    modelId.startsWith("gpt-") ||
    modelId.startsWith("o1-") ||
    modelId.startsWith("o3-") ||
    modelId.startsWith("o4-") ||
    modelId === "o1" ||
    modelId === "o3" ||
    modelId === "o4"
  ) return "OpenAI";
  if (modelId.startsWith("claude-")) return "Anthropic";
  if (modelId.startsWith("gemini-")) return "Google";
  if (modelId.startsWith("grok-")) return "xAI";
  return undefined;
}

/** Idle TTL before a session is evicted (10 minutes). */
const IDLE_TTL_MS = 10 * 60 * 1000;
/** How often to check for idle sessions (1 minute). */
const EVICTION_INTERVAL_MS = 60 * 1000;

interface SessionEntry {
  session: CopilotSession;
  lastUsedAt: number;
}

/** GitHub Copilot SDK adapter implementing IAgentProvider with callback-based event mapping. */
@injectable()
export class CopilotProvider extends EventEmitter implements IAgentProvider {
  readonly id: ProviderId = "copilot";
  readonly supportsCompletion = false;

  private client: CopilotClient | null = null;
  private lastCliPath: string | undefined;
  /** Cached result of `which("node")` so we don't re-probe PATH on every rebuild. */
  private cachedNodePath: string | null | undefined;
  private sessions = new Map<string, SessionEntry>();
  private sdkSessionIds = new Map<string, string>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  /** Serialises concurrent refreshClient() calls so only one rebuild runs at a time. */
  private clientStartLock: Promise<void> = Promise.resolve();

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
  ) {
    super();
  }

  /** Fetch available models from the Copilot SDK. */
  async listModels(): Promise<ProviderModelInfo[]> {
    await this.refreshClient();
    const client = this.client;
    if (!client) {
      throw new Error("Copilot client not available");
    }

    let sdkModels: ModelInfo[];
    try {
      sdkModels = await client.listModels();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // The SDK throws "Client not connected" when the CLI process died
      // after the initial handshake. Force a fresh client and retry once.
      if (msg.includes("not connected")) {
        logger.warn("CopilotProvider: listModels connection lost, reconnecting", { error: msg });
        this.client = null;
        await this.refreshClient();
        const freshClient = this.client as CopilotClient | null;
        if (!freshClient) {
          throw new Error("Copilot client not available after reconnect");
        }
        sdkModels = await freshClient.listModels();
      } else {
        throw e;
      }
    }

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

  /** Return current usage/quota state by fetching from account.getQuota(). */
  async getUsage(): Promise<ProviderUsageInfo> {
    try {
      await this.refreshClient();
      const result = await this.client!.rpc.account.getQuota();
      const categories = result?.quotaSnapshots
        ? normalizeQuotaSnapshots(result.quotaSnapshots)
        : [];
      return { providerId: "copilot", quotaCategories: categories };
    } catch (error) {
      logger.warn("Failed to fetch Copilot quota", { error });
      return { providerId: "copilot", quotaCategories: [] };
    }
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
    const configuredCliPath = settings.provider.cli.copilot || undefined;
    const state = this.client?.getState();

    // Reuse the existing client only when it is healthy. A "disconnected" or
    // "error" state means the CLI process died; rebuild so the next session
    // gets a fresh process rather than failing immediately.
    if (
      configuredCliPath === this.lastCliPath &&
      this.client !== null &&
      state === "connected"
    ) {
      return;
    }

    if (this.client) {
      await this.client.stop().catch((err) =>
        logger.warn("CopilotProvider: error stopping old client", { error: String(err) }),
      );
      this.client = null;
    }

    const opts: {
      cliPath?: string;
      githubToken?: string;
      env?: Record<string, string | undefined>;
    } = {};

    // User-configured CLI path takes priority over all other resolution.
    if (configuredCliPath) {
      opts.cliPath = configuredCliPath;
    }

    // Electron fix: resolve the real node binary path once. The SDK's
    // getNodeExecPath() reads process.execPath to spawn .js CLI files,
    // but in Electron that returns electron.exe which cannot host the
    // CLI's server mode. We temporarily override process.execPath during
    // client.start() and also prepend node's directory to PATH.
    if (process.versions.electron && !configuredCliPath) {
      if (this.cachedNodePath === undefined) {
        this.cachedNodePath = await which("node", { nothrow: true });
        if (!this.cachedNodePath) {
          logger.warn(
            "CopilotProvider: node not found in PATH; SDK will use process.execPath (electron)",
          );
        }
      }
      if (this.cachedNodePath) {
        const nodeDir = dirname(this.cachedNodePath);
        opts.env = {
          ...process.env,
          PATH: `${nodeDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        };
      }
    }

    // Explicit auth: get token from gh CLI so the headless subprocess
    // does not need to discover auth from its own environment.
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"], {
        timeout: 5000,
      });
      const token = stdout.trim();
      if (token) {
        opts.githubToken = token;
      }
    } catch (err) {
      logger.debug("CopilotProvider: gh auth token unavailable, falling back to SDK auth", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const client = new CopilotClient(opts as ConstructorParameters<typeof CopilotClient>[0]);
    // The SDK's createSession() auto-starts the connection, but listModels()
    // does not. Eagerly start the client so both paths work.
    //
    // Electron fix: the SDK reads process.execPath to spawn the CLI .js file.
    // In Electron that returns electron.exe, causing the CLI to exit immediately.
    // Temporarily override process.execPath with the real node binary.
    if (process.versions.electron && this.cachedNodePath) {
      const origExecPath = process.execPath;
      process.execPath = this.cachedNodePath;
      try {
        await client.start();
      } finally {
        process.execPath = origExecPath;
      }
    } else {
      await client.start();
    }
    // Assign only after start() succeeds so a failed startup never leaves
    // a stale non-started client on the instance.
    this.client = client;
    this.lastCliPath = configuredCliPath;
    logger.info("CopilotProvider: client started", { state: client.getState() });
  }

  /** Strip the "mcode-" session prefix to derive the threadId used in emitted AgentEvents. */
  private toThreadId(sessionId: string): string {
    return sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
  }

  /** Cached context window limit from the last session.usage_info event, keyed by sessionId. */
  private contextWindowBySession = new Map<string, number>();

  /** Start or continue a session by sending a message via the Copilot SDK. */
  async sendMessage(params: {
    sessionId: string;
    message: string;
    cwd: string;
    model: string;
    fallbackModel?: string;
    resume: boolean;
    permissionMode: string;
    attachments?: AttachmentMeta[];
    reasoningLevel?: ReasoningLevel;
  }): Promise<void> {
    try {
      await this.doSendMessage(params);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("CopilotProvider sendMessage error", {
        sessionId: params.sessionId,
        error: msg,
      });

      // Translate SDK-level CLI launch failures into actionable user messages.
      const threadId = this.toThreadId(params.sessionId);

      if (msg.includes("CLI server exited")) {
        // The @github/copilot process died — discard the dead client so
        // refreshClient() rebuilds it on the next attempt.
        this.client = null;
        const userMsg =
          "GitHub Copilot CLI exited unexpectedly.\n\n" +
          "Ensure you are authenticated: run `gh auth login` and confirm you have an active GitHub Copilot subscription.";
        this.emit("event", { type: "error", threadId, error: userMsg } satisfies AgentEvent);
        this.emit("event", { type: "ended", threadId } satisfies AgentEvent);
        return;
      }

      if (msg.includes("Could not find @github/copilot")) {
        const userMsg =
          "GitHub Copilot package not found.\n\n" +
          "Install it with: npm install -g @github/copilot\n\n" +
          "Or set a custom path in Settings > Provider > Copilot CLI path.";
        this.emit("event", { type: "error", threadId, error: userMsg } satisfies AgentEvent);
        this.emit("event", { type: "ended", threadId } satisfies AgentEvent);
        return;
      }

      throw e;
    }
  }

  private async doSendMessage(params: {
    sessionId: string;
    message: string;
    cwd: string;
    model: string;
    fallbackModel?: string;
    resume: boolean;
    permissionMode: string;
    attachments?: AttachmentMeta[];
    reasoningLevel?: ReasoningLevel;
  }): Promise<void> {
    await this.refreshClient();

    const { sessionId, message, cwd, model, resume } = params;

    if (!this.evictionTimer) {
      this.evictionTimer = setInterval(
        () => this.evictIdleSessions(),
        EVICTION_INTERVAL_MS,
      );
    }

    const threadId = this.toThreadId(sessionId);

    // Double-checked locking: re-read after the async refreshClient() await so
    // concurrent sendMessage calls that both passed the first check don't each
    // create a new SDK session for the same sessionId.
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      // Abort in-flight turn by sending a new message on the existing session.
      // The previous runTurn promise will resolve when session.idle fires.
      void this.runTurn(sessionId, threadId, existing.session, message);
      return;
    }

    const client = this.client;
    if (!client) {
      throw new Error("Copilot client not available");
    }
    const sdkSessionId = this.sdkSessionIds.get(sessionId);

    let session: CopilotSession;

    // TODO(#258): respect params.permissionMode. Currently approveAll is used
    // unconditionally because the Copilot SDK does not expose per-action gating.
    // Until the SDK adds granular permission control, all tool actions are
    // approved automatically regardless of the thread's permissionMode setting.
    if (resume && sdkSessionId) {
      try {
        session = await client.resumeSession(sdkSessionId, {
          onPermissionRequest: approveAll,
          model: model || undefined,
          workingDirectory: cwd,
        });
        logger.info("Resumed Copilot session", { sessionId, sdkSessionId });
      } catch (err) {
        logger.warn("CopilotProvider: resume failed, starting fresh session", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.sdkSessionIds.delete(sessionId);
        session = await client.createSession({
          onPermissionRequest: approveAll,
          model: model || undefined,
          workingDirectory: cwd,
        });
      }
    } else {
      session = await client.createSession({
        onPermissionRequest: approveAll,
        model: model || undefined,
        workingDirectory: cwd,
      });
    }

    // Capture the SDK session ID for future resume and notify the service layer
    const sdkId = session.sessionId;
    if (sdkId && !this.sdkSessionIds.has(sessionId)) {
      this.sdkSessionIds.set(sessionId, sdkId);
      logger.info("Captured Copilot SDK session ID", { sessionId, sdkId });
      this.emit("event", {
        type: "system",
        threadId,
        subtype: "sdk_session_id:" + sdkId,
      } satisfies AgentEvent);
    }

    const entry: SessionEntry = {
      session,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(sessionId, entry);

    void this.runTurn(sessionId, threadId, session, message);
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
  ): Promise<void> {
    // Track per-tool start times to derive elapsedSeconds for toolProgress events.
    const toolStartTimes = new Map<string, number>();

    const unsubscribers: Array<() => void> = [];

    try {
      const turnPromise = new Promise<void>((resolve) => {
        // assistant.message_delta — streaming text chunk
        unsubscribers.push(
          session.on("assistant.message_delta", (event) => {
            const entry = this.sessions.get(sessionId);
            if (entry) entry.lastUsedAt = Date.now();

            this.emit("event", {
              type: "textDelta",
              threadId,
              delta: event.data.deltaContent,
            } satisfies AgentEvent);
          }),
        );

        // assistant.message — final complete assistant response
        unsubscribers.push(
          session.on("assistant.message", (event) => {
            this.emit("event", {
              type: "message",
              threadId,
              content: event.data.content,
              tokens: event.data.outputTokens ?? null,
            } satisfies AgentEvent);
          }),
        );

        // tool.execution_start — assistant is invoking a tool
        unsubscribers.push(
          session.on("tool.execution_start", (event) => {
            const { toolCallId, toolName, arguments: toolArgs } = event.data;
            toolStartTimes.set(toolCallId, Date.now());
            this.emit("event", {
              type: "toolUse",
              threadId,
              toolCallId,
              toolName,
              toolInput: toolArgs ?? {},
            } satisfies AgentEvent);
          }),
        );

        // tool.execution_complete — tool has finished
        unsubscribers.push(
          session.on("tool.execution_complete", (event) => {
            const { toolCallId, success, result } = event.data;
            toolStartTimes.delete(toolCallId);
            this.emit("event", {
              type: "toolResult",
              threadId,
              toolCallId,
              output: result?.content ?? "",
              isError: !success,
            } satisfies AgentEvent);
          }),
        );

        // tool.execution_progress — heartbeat while a tool runs
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
            this.emit("event", {
              type: "toolProgress",
              threadId,
              // toolName is not provided in tool.execution_progress; omit gracefully
              toolCallId,
              toolName: "",
              elapsedSeconds,
            } satisfies AgentEvent);
          }),
        );

        // session.usage_info — live context window metrics emitted each turn
        unsubscribers.push(
          session.on("session.usage_info", (event) => {
            const { tokenLimit, currentTokens } = event.data as {
              tokenLimit: number;
              currentTokens: number;
            };
            this.contextWindowBySession.set(sessionId, tokenLimit);
            this.emit("event", {
              type: "contextEstimate",
              threadId,
              tokensIn: currentTokens,
              contextWindow: tokenLimit,
            } satisfies AgentEvent);
          }),
        );

        // assistant.usage — token counts after a model call
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
            const contextWindow = this.contextWindowBySession.get(sessionId);

            this.emit("event", {
              type: AgentEventType.TurnComplete,
              threadId,
              reason: "end_turn",
              costUsd: null,
              tokensIn: inputTokens,
              tokensOut: outputTokens,
              contextWindow,
              totalProcessedTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
              costMultiplier: cost,
              providerId: "copilot",
            } satisfies AgentEvent);

            // Emit quota update if snapshots are present
            if (quotaSnapshots && typeof quotaSnapshots === "object") {
              this.emit("event", {
                type: AgentEventType.QuotaUpdate,
                threadId,
                providerId: "copilot",
                categories: normalizeQuotaSnapshots(quotaSnapshots as Record<string, QuotaSnapshot>),
              } satisfies AgentEvent);
            }
          }),
        );

        // session.error — provider-level error; resolve so cleanup runs.
        // Also evict the session entry so the next sendMessage creates a fresh
        // session rather than reusing a potentially dead one.
        unsubscribers.push(
          session.on("session.error", (event) => {
            this.emit("event", {
              type: "error",
              threadId,
              error: event.data.message,
            } satisfies AgentEvent);
            this.sessions.delete(sessionId);
            this.contextWindowBySession.delete(sessionId);
            resolve();
          }),
        );

        // session.compaction_start — context window compaction beginning
        unsubscribers.push(
          session.on("session.compaction_start", () => {
            this.emit("event", {
              type: "compacting",
              threadId,
              active: true,
            } satisfies AgentEvent);
          }),
        );

        // session.compaction_complete — compaction finished; emit summary if present
        unsubscribers.push(
          session.on("session.compaction_complete", (event) => {
            if (event.data.summaryContent) {
              this.emit("event", {
                type: "compactSummary",
                threadId,
                summary: event.data.summaryContent,
              } satisfies AgentEvent);
            }
            this.emit("event", {
              type: "compacting",
              threadId,
              active: false,
            } satisfies AgentEvent);
          }),
        );

        // session.idle — turn is complete; resolve and clean up handlers
        unsubscribers.push(
          session.on("session.idle", () => {
            resolve();
          }),
        );
      });

      await session.send({ prompt: message });
      await turnPromise;
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      logger.error("CopilotProvider turn error", { sessionId, error: errorMessage });
      this.emit("event", {
        type: "error",
        threadId,
        error: errorMessage,
      } satisfies AgentEvent);
    } finally {
      // Deregister all per-turn handlers to prevent memory leaks across turns
      for (const unsub of unsubscribers) {
        unsub();
      }
      this.emit("event", {
        type: "ended",
        threadId,
      } satisfies AgentEvent);
    }
  }

  /** Evict sessions that have been idle longer than IDLE_TTL_MS. */
  private evictIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastUsedAt > IDLE_TTL_MS) {
        logger.info("Evicting idle Copilot session", { sessionId });
        entry.session.disconnect().catch((err) =>
          logger.warn("CopilotProvider: error disconnecting evicted session", {
            sessionId,
            error: String(err),
          }),
        );
        this.sessions.delete(sessionId);
        this.contextWindowBySession.delete(sessionId);
      }
    }
  }

  /** Pre-load an SDK session ID mapping (e.g. from the database on startup). */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    this.sdkSessionIds.set(sessionId, sdkSessionId);
  }

  /** Disconnect and remove an active session. */
  stopSession(sessionId: string): void {
    this.contextWindowBySession.delete(sessionId);
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.session.disconnect().catch((err) =>
        logger.warn("CopilotProvider: error disconnecting stopped session", {
          sessionId,
          error: String(err),
        }),
      );
      this.sessions.delete(sessionId);
    }
  }

  /** Tear down all sessions, stop the client, and release resources. */
  shutdown(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }

    for (const [sessionId, entry] of this.sessions) {
      entry.session.disconnect().catch((err) =>
        logger.warn("CopilotProvider: error disconnecting session during shutdown", {
          sessionId,
          error: String(err),
        }),
      );
    }
    this.sessions.clear();
    this.sdkSessionIds.clear();
    this.contextWindowBySession.clear();

    if (this.client) {
      this.client.stop().catch((err) =>
        logger.warn("CopilotProvider: error stopping client during shutdown", {
          error: String(err),
        }),
      );
      this.client = null;
    }

    logger.info("CopilotProvider shutdown complete");
  }
}
