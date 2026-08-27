/**
 * @internal
 * Cursor CLI provider via long-lived `cursor-agent acp` (Agent Client Protocol).
 *
 * One subprocess per Mcode thread keeps JSON-RPC on stdio stable across turns.
 * When `session/load` fails (known Cursor limitations), we fall back to `session/new`
 * and emit `sdk_session_id` so the DB tracks the active session id.
 */

import { EventEmitter } from "node:events";
import { logger } from "@mcode/shared";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { ProviderIdentity } from "@mcode/agent-model";

import {
  providerBrowserPermissionCapability,
  type ProviderHostPorts,
  type ProviderThreadControlHttpConnection,
} from "../../host-ports.js";
import type { CursorProviderPorts } from "../../factory-types.js";
import { SessionRuntime } from "../session-runtime.js";
import type { ProtocolAdapter, SpawnArgs, SpawnResult } from "../session-runtime.js";
import {
  AgentEventType,
  CURSOR_STATIC_MODEL_FALLBACK,
  getCatalogEntry,
} from "@mcode/contracts";
import type {
  AgentEvent,
  IAgentProvider,
  ISessionEvictable,
  TurnRequest,
  PermissionDecision,
  PermissionRequest,
  ProviderModelInfo,
  Settings,
} from "@mcode/contracts";
import { fetchCursorCliModels } from "./models/cursor-cli-models.js";
import { buildMcodeInstructionPlan, renderMcodeInstructions } from "@mcode/thread-orchestration";
import { AcpSessionRuntime } from "../protocols/acp/acp-session-runtime.js";
import { CursorAcpClientBridge } from "./acp/cursor-acp-client-bridge.js";
import { CursorAcpProcessSpawner } from "./runtime/cursor-acp-process-spawner.js";
import { CursorTurnExecutor } from "./runtime/cursor-turn-executor.js";
import {
  CursorSideChannel,
} from "./handoff/cursor-side-channel.js";
import { CursorCleanForker } from "./handoff/cursor-clean-forker.js";
import type {
  CursorAcpSessionEntry,
  CursorBrowserContext,
  CursorBrowserLeaseGrant,
  CursorBrowserLeaseHandle,
  CursorSessionState,
} from "./cursor-session-state.js";
import {
  CursorCanonicalEventPublisher,
  type CursorCanonicalEventRouting,
} from "./cursor-canonical-event-publisher.js";

export { cursorSupportsHttpMcp } from "./acp/cursor-acp-capabilities.js";
export { appendCursorMcodeInstructions } from "./runtime/cursor-turn-executor.js";

/** Builds the ACP HTTP MCP configuration for one provider session. */
export function buildCursorInternalMcpServers(
  connection: ProviderThreadControlHttpConnection,
): McpServer[] {
  return [{
    type: "http",
    name: connection.name,
    url: connection.url,
    headers: Object.entries(connection.headers).map(([name, value]) => ({ name, value })),
  }];
}

type BrowserAutomationSessionLeaseGrant = CursorBrowserLeaseGrant;
type BrowserAutomationSessionLeaseStage = CursorBrowserLeaseHandle;

type CursorTurnContext = {
  req: TurnRequest<"cursor">;
  sessionId: string;
  threadId: string;
  routing: CursorCanonicalEventRouting;
  resume: boolean;
  browserContext: CursorBrowserContext;
  browserPermissionCapability: ReturnType<typeof providerBrowserPermissionCapability>;
};

const CURSOR_SUPPORTED_CAPABILITIES = [
  "build",
  "plan",
  "permissions",
  "session-eviction",
  "clean-fork",
  "browser-access",
  "thread-control",
] as const;

function cursorCliProbeBinaries(settings: Settings): string[] {
  const configured = settings.provider.cli.cursor?.trim();
  return configured ? [configured] : [getCatalogEntry("cursor").cliBinary, "agent"];
}

function isThreadControlHttpConnection(value: unknown): value is ProviderThreadControlHttpConnection {
  if (!value || typeof value !== "object") return false;
  const connection = value as Record<string, unknown>;
  return typeof connection.name === "string"
    && typeof connection.url === "string"
    && typeof connection.headers === "object"
    && connection.headers !== null
    && !Array.isArray(connection.headers);
}

/** Builds the ACP HTTP MCP descriptor for one short-lived browser grant. */
export function buildCursorBrowserMcpServers(
  grant: Pick<BrowserAutomationSessionLeaseGrant, "mcpUrl" | "token"> | null,
): McpServer[] {
  return grant
    ? [{
        type: "http",
        name: "mcode-browser",
        url: grant.mcpUrl,
        headers: [{ name: "Authorization", value: `Bearer ${grant.token}` }],
      }]
    : [];
}

/** Carries one-time guidance state only across a successful stored-session reload. */
export function carryCursorMcodeSentState(
  logicalSessionReloaded: boolean,
  sent: boolean,
): boolean {
  return logicalSessionReloaded && sent;
}

/** Cursor ACP adapter implementing IAgentProvider through one private MCP subprocess per session. */
export class CursorProvider
  extends EventEmitter
  implements IAgentProvider, ISessionEvictable, ProtocolAdapter<CursorSessionState>
{
  readonly id = "cursor" as const;
  readonly descriptor = Object.freeze({
    id: "cursor" as const,
    capabilities: [
      ...CURSOR_SUPPORTED_CAPABILITIES.map((name) => ({ name, support: "supported" as const })),
      { name: "provider-continuation" as const, support: "unsupported" as const },
      { name: "child-cancellation" as const, support: "unsupported" as const },
    ],
  });
  readonly supportsCompletion = false;
  readonly eventDelivery = "canonical-sink" as const;
  readonly sessionForkOnResume = "clean" as const;
  readonly maxInputCharactersPerTurn = 4_000;
  /** Path B forker; calls this provider's runSideChannelQuery on a forked copy of the parent session. */
  readonly forker = new CursorCleanForker(this);

  /** Owns the session pool, idle eviction, and server-managed process cleanup. */
  private readonly runtime: SessionRuntime<CursorSessionState>;
  private sdkSessionIds = new Map<string, string>();
  /** Binds each ACP prompt state to its immutable Mcode routing. */
  private readonly turnRoutingByState = new WeakMap<object, CursorCanonicalEventRouting>();
  /** Binds a request that is still opening to its Mcode routing for stop teardown. */
  private readonly pendingTurnRoutings = new Map<string, CursorCanonicalEventRouting>();
  /** Serializes canonical sink delivery for each Cursor execution. */
  private readonly canonicalEventPublisher: CursorCanonicalEventPublisher;
  /**
   * Session IDs for which a stop was requested before the session was created.
   * Checked after session creation; if found the session is torn down immediately.
   */
  private pendingStops = new Set<string>();
  /** ACP runtimes still opening before SessionRuntime can own their state. */
  private pendingAcpRuntimes = new Map<string, AcpSessionRuntime>();
  /**
   * Mcode session ids the runtime currently holds. The runtime owns the pool
   * but exposes only `get(id)`, so the provider mirrors the live id set to be
   * able to iterate sessions (e.g. sticky-instruction invalidation). Populated
   * in `spawn`, pruned in `close`.
   */
  private liveSessionIds = new Set<string>();
  /** Browser lease staged only until a fresh normal ACP session opens. */
  private pendingBrowserLeases = new Map<string, BrowserAutomationSessionLeaseStage>();
  /** Non-secret provider state needed while a staged lease is being opened. */
  private pendingBrowserContext = new Map<string, CursorBrowserContext>();
  /** Refreshed browser grant carried across a provider restart. */
  private pendingBrowserGrants = new Map<string, BrowserAutomationSessionLeaseGrant>();
  /** Context captured with a refreshed grant so a changed request cannot reuse it. */
  private pendingBrowserGrantContext = new Map<string, CursorBrowserContext>();
  private readonly settingsService: CursorProviderPorts["settings"];
  private readonly skillService: CursorProviderPorts["skills"];
  private readonly envService: { getEnv(): Record<string, string> };
  private readonly browserAutomationLease: ProviderHostPorts["browser"];
  private readonly threadControlMcp: {
    createHttpConnection(sessionId: string): Promise<ProviderThreadControlHttpConnection | undefined>;
    close(sessionId: string): Promise<void>;
  };
  private acpClientBridge?: CursorAcpClientBridge;
  private processSpawner?: CursorAcpProcessSpawner;
  private turnExecutor?: CursorTurnExecutor;
  private sideChannel?: CursorSideChannel;

  constructor(
    private readonly host: ProviderHostPorts,
    private readonly cursorPorts: CursorProviderPorts,
    idleSessionTtlMs: number,
  ) {
    super();
    this.canonicalEventPublisher = new CursorCanonicalEventPublisher(host.events);
    this.settingsService = cursorPorts.settings;
    this.skillService = cursorPorts.skills;
    this.envService = { getEnv: () => ({ ...host.environment.snapshot() }) };
    this.browserAutomationLease = host.browser;
    this.threadControlMcp = {
      createHttpConnection: async (sessionId) => {
        const threadId = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
        const connection = await host.threadControl.bootstrap({
          providerId: this.id,
          sessionId,
          threadId,
          protocol: "http",
        });
        return isThreadControlHttpConnection(connection) ? connection : undefined;
      },
      close: (sessionId) => host.threadControl.close(sessionId),
    };
    this.runtime = new SessionRuntime<CursorSessionState>(this, {
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      processes: host.processes,
      envService: { getEnv: () => ({ ...this.host.environment.snapshot() }) },
      idleTtlMs: idleSessionTtlMs,
    });
    this.getAcpClientBridge();
    this.getProcessSpawner();
    this.getTurnExecutor();
    this.getSideChannel();
  }

  private getAcpClientBridge(): CursorAcpClientBridge {
    if (!this.acpClientBridge) {
      this.acpClientBridge = new CursorAcpClientBridge({
        settings: this.settingsService,
        publishEvent: (entry, event) => this.publishCursorEvent(
          this.turnRoutingForEntry(entry),
          event,
          this.acpSessionIdentities(entry),
        ),
        emitPermissionRequest: (request) => {
          try {
            this.emit("permission_request", request);
          } catch {
            // Event subscribers must not prevent ACP from receiving its decision.
          }
        },
        emitPermissionResolved: (requestId, decision) => {
          try {
            this.emit("permission_resolved", { requestId, decision });
          } catch {
            // Permission completion must not depend on a renderer subscriber.
          }
        },
        emitExitPlanMode: (args) => this.emit("exit_plan_mode", args),
      });
    }
    return this.acpClientBridge;
  }

  private getProcessSpawner(): CursorAcpProcessSpawner {
    if (!this.processSpawner) {
      this.processSpawner = new CursorAcpProcessSpawner({
        host: this.host,
        getEnvironment: () => this.envService.getEnv(),
        getSettings: () => this.settingsService.get(),
        getBrowserContext: (sessionId) => this.pendingBrowserContext.get(sessionId),
        registerOpening: (sessionId, runtime) => {
          (this.pendingAcpRuntimes ??= new Map()).set(sessionId, runtime);
        },
        clearOpening: (sessionId) => this.pendingAcpRuntimes?.delete(sessionId),
        onChildExit: (sessionId, child) => {
          const pooled = this.runtime.get(sessionId);
          if (pooled?.child !== child) return;
          this.getAcpClientBridge().cancelPendingForSession(sessionId);
          void this.runtime.stop(sessionId);
        },
        bridge: this.getAcpClientBridge(),
      });
    }
    return this.processSpawner;
  }

  private getTurnExecutor(): CursorTurnExecutor {
    if (!this.turnExecutor) {
      this.turnExecutor = new CursorTurnExecutor({
        settings: this.settingsService,
        skills: this.skillService,
        publishEvent: (entry, event) => this.publishCursorEvent(
          this.turnRoutingForEntry(entry),
          event,
          this.acpSessionIdentities(entry),
        ),
        bindTurnRouting: (entry, routing) => {
          if (entry.activeTurnState) {
            this.turnRoutingByState.set(entry.activeTurnState, routing);
          }
        },
        openLogicalSession: (entry, resume) => this.openLogicalSession(entry, resume),
        applyModel: (entry, model) => this.applyModel(entry, model),
        respawnAfterDisconnect: (entry) => this.respawnCursorSessionAfterAcpClose(entry),
      });
    }
    return this.turnExecutor;
  }

  private getSideChannel(): CursorSideChannel {
    if (!this.sideChannel) {
      this.sideChannel = new CursorSideChannel({
        host: this.host,
        getEnvironment: () => this.envService.getEnv(),
        getCliCandidates: () => cursorCliProbeBinaries(this.settingsService.get()),
        readWorkspaceFile: (cwd, filePath) => this.getAcpClientBridge().readWorkspaceFile(cwd, filePath),
      });
    }
    return this.sideChannel;
  }

  /** Lists models by running `cursor-agent models` (falls back when discovery fails). */
  async listModels(): Promise<ProviderModelInfo[]> {
    const settings = this.cursorPorts.settings.get();

    for (const cliPath of cursorCliProbeBinaries(settings)) {
      const discovered = await fetchCursorCliModels(cliPath);
      if (discovered?.length) {
        return discovered;
      }
    }

    logger.info("Cursor listModels: using static fallback (CLI discovery unavailable)");
    return [...CURSOR_STATIC_MODEL_FALLBACK];
  }

  /** Queues an ACP `session/prompt` on the session subprocess (serialized per thread). */
  async sendTurn(req: TurnRequest<"cursor">): Promise<void> {
    const context = this.prepareTurnContext(req);
    const { sessionId } = context;
    // `resumeFrom` defined ⇒ resume the stored ACP session; undefined ⇒ fresh.
    this.releaseMismatchedPendingBrowserGrant(context);
    const existing = await this.rotateCompletedSession(sessionId);
    const browserStage = await this.prepareBrowserLeaseForTurn(context, existing);

    const entry = await this.acquireTurnSession(context, browserStage);
    if (!entry) return;
    this.clearBrowserStageAfterAcquire(sessionId, browserStage, entry, existing);
    if (await this.consumePendingStop(context)) return;

    try {
      await this.enqueueTurn(entry, context);
    } finally {
      this.finishPendingTurnRouting(sessionId, req.turnExecutionId);
    }
  }


  private prepareTurnContext(req: TurnRequest<"cursor">): CursorTurnContext {
    void req.fallbackModel;
    void req.reasoningLevel;
    const resume = req.resumeFrom !== undefined;
    if (req.resumeFrom !== undefined) {
      this.sdkSessionIds.set(req.sessionId, req.resumeFrom);
    }

    const threadId = req.sessionId.startsWith("mcode-") ? req.sessionId.slice(6) : req.sessionId;
    const browserPermissionCapability = providerBrowserPermissionCapability(
      req.permissionMode,
      req.interactionMode,
    );
    const browserContext: CursorBrowserContext = {
      workspaceId: req.workspaceId,
      browserPermissionCapability,
    };
    const routing: CursorCanonicalEventRouting = {
      threadId: req.threadId,
      turnId: req.turnId,
      executionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
    };
    this.pendingTurnRoutings.set(req.sessionId, routing);
    this.getAcpClientBridge().setPlanQuestionMode(threadId, req.interactionMode === "plan");
    return {
      req,
      sessionId: req.sessionId,
      threadId,
      routing,
      resume,
      browserContext,
      browserPermissionCapability,
    };
  }

  private turnRoutingForEntry(entry: CursorAcpSessionEntry): CursorCanonicalEventRouting | undefined {
    if (entry.activeTurnState) {
      const activeRouting = this.turnRoutingByState.get(entry.activeTurnState);
      if (activeRouting) return activeRouting;
    }
    return this.pendingTurnRoutings.get(entry.mcodeSessionId);
  }

  private acpSessionIdentities(entry: CursorAcpSessionEntry): readonly ProviderIdentity[] {
    if (!entry.acpSessionId) return [];
    return [{
      providerId: this.id,
      scope: "session" as const,
      value: entry.acpSessionId,
      provenance: "native" as const,
    }];
  }

  private publishCursorEvent(
    routing: CursorCanonicalEventRouting | undefined,
    event: AgentEvent,
    sourceIdentities: readonly ProviderIdentity[] = [],
  ): void {
    if (!routing) {
      logger.warn("Cursor event had no active turn routing", { type: event.type, threadId: event.threadId });
      return;
    }
    this.canonicalEventPublisher.publish(routing, event, sourceIdentities);
  }

  private releaseMismatchedPendingBrowserGrant(context: CursorTurnContext): void {
    const grant = this.pendingBrowserGrants.get(context.sessionId);
    if (!grant) return;
    const grantContext = this.pendingBrowserGrantContext.get(context.sessionId);
    if (grantContext && this.sameBrowserContext(grantContext, context.browserContext)) return;

    this.releaseBrowserLeases(grant);
    this.pendingBrowserGrants.delete(context.sessionId);
    this.pendingBrowserGrantContext.delete(context.sessionId);
  }

  private async rotateCompletedSession(sessionId: string): Promise<CursorSessionState | undefined> {
    const entry = this.runtime.get(sessionId);
    if (!entry) return undefined;
    if (entry.activeTurnState !== null) return entry;
    if (entry.cursorPromptOrdinal <= 0) return entry;

    await this.runtime.stop(sessionId);
    return undefined;
  }

  private async prepareBrowserLeaseForTurn(
    context: CursorTurnContext,
    existing: CursorSessionState | undefined,
  ): Promise<BrowserAutomationSessionLeaseStage | undefined> {
    let browserStage = await this.reconcileExistingBrowserLease(context, existing);
    if (!this.runtime.get(context.sessionId)) {
      browserStage = this.stageBrowserLeaseForMissingSession(context);
    }
    return browserStage;
  }

  private async reconcileExistingBrowserLease(
    context: CursorTurnContext,
    existing: CursorSessionState | undefined,
  ): Promise<BrowserAutomationSessionLeaseStage | undefined> {
    if (!existing) return undefined;

    const browserContextChanged = this.browserContextChanged(existing, context.browserContext);
    const browserExpired = this.browserCredentialExpired(existing);
    const acquireWillReplace = this.isStale(existing, {
      cwd: context.req.cwd,
      permissionMode: context.req.permissionMode,
    });
    if (!browserContextChanged && !browserExpired && !acquireWillReplace) return undefined;

    this.refreshExpiredBrowserGrant(context, existing, browserContextChanged, browserExpired);
    const browserStage = this.stageBrowserLeaseForReplacement(context, acquireWillReplace);
    await this.runtime.stop(context.sessionId);
    return browserStage;
  }

  private browserContextChanged(
    entry: CursorSessionState,
    browserContext: CursorBrowserContext,
  ): boolean {
    return entry.workspaceId !== browserContext.workspaceId ||
      entry.browserPermissionCapability !== browserContext.browserPermissionCapability;
  }

  private browserCredentialExpired(entry: CursorSessionState): boolean {
    const credential = entry.browserCredential;
    return credential !== undefined && credential.expiresAt <= Date.now();
  }

  private refreshExpiredBrowserGrant(
    context: CursorTurnContext,
    entry: CursorSessionState,
    browserContextChanged: boolean,
    browserExpired: boolean,
  ): void {
    if (browserContextChanged) return;
    if (!browserExpired) return;
    const credential = entry.browserCredential;
    if (!credential) return;

    const refreshed = this.browserAutomationLease.refresh(credential.leaseId);
    if (!refreshed.ok) return;

    this.pendingBrowserGrants.set(context.sessionId, refreshed.grant);
    this.pendingBrowserGrantContext.set(context.sessionId, context.browserContext);
    entry.browserCredential = undefined;
  }

  private stageBrowserLeaseForReplacement(
    context: CursorTurnContext,
    acquireWillReplace: boolean,
  ): BrowserAutomationSessionLeaseStage | undefined {
    if (!acquireWillReplace) return undefined;
    if (this.pendingBrowserGrants.has(context.sessionId)) return undefined;
    return this.stageBrowserLease(context);
  }

  private stageBrowserLeaseForMissingSession(
    context: CursorTurnContext,
  ): BrowserAutomationSessionLeaseStage | undefined {
    if (this.pendingBrowserGrants.has(context.sessionId)) {
      this.discardStagedBrowserLease(context.sessionId);
      return undefined;
    }
    return this.stageBrowserLease(context);
  }

  private stageBrowserLease(
    context: CursorTurnContext,
  ): BrowserAutomationSessionLeaseStage | undefined {
    const existingStage = this.pendingBrowserLeases.get(context.sessionId);
    if (existingStage && !this.hasMatchingStagedBrowserContext(context)) {
      this.discardStagedBrowserLease(context.sessionId);
    }

    const retainedStage = this.pendingBrowserLeases.get(context.sessionId);
    if (retainedStage) return retainedStage;
    if (!this.browserAutomationLease.isConfigured()) return undefined;

    const browserStage = this.browserAutomationLease.stage({
      providerId: this.id,
      providerSessionId: context.req.resumeFrom ?? context.sessionId,
      mcodeSessionId: context.sessionId,
      threadId: context.req.threadId,
      workspaceId: context.req.workspaceId,
      permissionCapability: context.browserPermissionCapability,
    });
    this.pendingBrowserLeases.set(context.sessionId, browserStage);
    this.pendingBrowserContext.set(context.sessionId, context.browserContext);
    return browserStage;
  }

  private hasMatchingStagedBrowserContext(context: CursorTurnContext): boolean {
    const stagedContext = this.pendingBrowserContext.get(context.sessionId);
    if (!stagedContext) return false;
    return this.sameBrowserContext(stagedContext, context.browserContext);
  }

  private discardStagedBrowserLease(sessionId: string): void {
    this.releaseBrowserLeases(this.pendingBrowserLeases.get(sessionId));
    this.pendingBrowserLeases.delete(sessionId);
    this.pendingBrowserContext.delete(sessionId);
  }

  private async acquireTurnSession(
    context: CursorTurnContext,
    browserStage: BrowserAutomationSessionLeaseStage | undefined,
  ): Promise<CursorSessionState | undefined> {
    try {
      return await this.runtime.acquire({
        sessionId: context.sessionId,
        threadId: context.threadId,
        cwd: context.req.cwd,
        permissionMode: context.req.permissionMode,
        resumeFrom: context.resume ? this.sdkSessionIds.get(context.sessionId) : undefined,
      });
    } catch (error) {
      await this.handleTurnAcquireFailure(context, browserStage, error);
      return undefined;
    }
  }

  private async handleTurnAcquireFailure(
    context: CursorTurnContext,
    browserStage: BrowserAutomationSessionLeaseStage | undefined,
    error: unknown,
  ): Promise<void> {
    this.releaseBrowserLeases(browserStage);
    this.pendingBrowserLeases.delete(context.sessionId);
    this.pendingBrowserContext.delete(context.sessionId);
    this.releaseBrowserLeases(this.pendingBrowserGrants.get(context.sessionId));
    this.pendingBrowserGrants.delete(context.sessionId);
    this.pendingBrowserGrantContext.delete(context.sessionId);
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Cursor ACP spawn failed", { sessionId: context.sessionId, error: errorMessage });
    this.publishCursorEvent(context.routing, {
      type: AgentEventType.Error,
      threadId: context.threadId,
      turnExecutionId: context.req.turnExecutionId,
      error: errorMessage,
    } satisfies AgentEvent);
    this.publishCursorEvent(context.routing, {
      type: AgentEventType.Ended,
      threadId: context.threadId,
      turnExecutionId: context.req.turnExecutionId,
    } satisfies AgentEvent);
    await this.canonicalEventPublisher.waitForExecution(context.routing);
    this.finishPendingTurnRouting(context.sessionId, context.req.turnExecutionId);
  }

  private clearBrowserStageAfterAcquire(
    sessionId: string,
    browserStage: BrowserAutomationSessionLeaseStage | undefined,
    entry: CursorSessionState,
    existing: CursorSessionState | undefined,
  ): void {
    this.pendingBrowserLeases.delete(sessionId);
    this.pendingBrowserContext.delete(sessionId);
    if (browserStage && entry === existing) this.releaseBrowserLeases(browserStage);
  }

  private async consumePendingStop(context: CursorTurnContext): Promise<boolean> {
    if (!this.pendingStops.delete(context.sessionId)) return false;

    logger.info("Pending stop consumed, tearing down new Cursor session", {
      sessionId: context.sessionId,
    });
    const stopped = this.runtime.stop(context.sessionId);
    this.publishCursorEvent(context.routing, {
      type: AgentEventType.Ended,
      threadId: context.threadId,
      turnExecutionId: context.req.turnExecutionId,
    } satisfies AgentEvent);
    await Promise.all([
      stopped,
      this.canonicalEventPublisher.waitForExecution(context.routing),
    ]);
    this.finishPendingTurnRouting(context.sessionId, context.req.turnExecutionId);
    return true;
  }

  private async enqueueTurn(
    entry: CursorSessionState,
    context: CursorTurnContext,
  ): Promise<void> {
    this.runtime.recordUsage(context.sessionId);
    entry.lastUsedAt = Date.now();
    const scheduled = entry.turnChain.then(() => this.runTurn(entry, {
      message: context.req.message,
      model: context.req.model,
      resume: context.resume,
      attachments: context.req.attachments,
      turnId: context.req.turnId,
      turnExecutionId: context.req.turnExecutionId,
      deliveryAttempt: context.routing.deliveryAttempt,
    }));
    entry.turnChain = scheduled.then(
      () => {},
      () => {},
    );
    await scheduled;
    await this.canonicalEventPublisher.waitForExecution(context.routing);
  }

  private finishPendingTurnRouting(sessionId: string, executionId: string): void {
    if (this.pendingTurnRoutings.get(sessionId)?.executionId !== executionId) return;
    this.pendingTurnRoutings.delete(sessionId);
  }

  /**
   * Cancel the active ACP session. Once the logical ACP session is open, a stop
   * issues a graceful ACP cancel (and flags `pendingUserStopAbort` when a prompt
   * is in flight so the in-progress turn settles as a user stop) — the runtime
   * is not torn down, the warm session stays pooled for the next turn, matching
   * prior behavior. When the entry exists but the ACP session has not opened
   * yet, hand it to `runtime.stop` (interrupt → close → hard kill). Records a
   * pending stop if the session has not spawned at all.
   */
  async stopSession(sessionId: string): Promise<void> {
    const entry = this.runtime.get(sessionId);
    this.getAcpClientBridge().cancelPendingForSession(sessionId);
    if (entry?.acpSessionId) {
      if (entry.activeTurnState) entry.pendingUserStopAbort = true;
      await entry.acpRuntime.cancel().catch(() => {});
      return;
    }
    if (entry) {
      await this.stopUnopenedSession(sessionId, entry);
      return;
    }
    await this.stopOpeningOrPendingSession(sessionId);
  }

  private async stopUnopenedSession(
    sessionId: string,
    entry: CursorSessionState,
  ): Promise<void> {
    const routing = this.turnRoutingForEntry(entry);
    const sourceIdentities = this.acpSessionIdentities(entry);
    await this.runtime.stop(sessionId);
    if (!routing) return;
    this.publishCursorEvent(routing, {
      type: AgentEventType.Ended,
      threadId: routing.threadId,
      turnExecutionId: routing.executionId,
    } satisfies AgentEvent, sourceIdentities);
    await this.canonicalEventPublisher.waitForExecution(routing);
  }

  private async stopOpeningOrPendingSession(sessionId: string): Promise<void> {
    this.pendingStops.add(sessionId);
    const openingRuntime = this.pendingAcpRuntimes.get(sessionId);
    if (openingRuntime) {
      await openingRuntime.close();
      return;
    }
    setTimeout(() => this.pendingStops.delete(sessionId), 10_000);
  }

  /**
   * Force-discard the pooled session so the next sendTurn spawns fresh. Unlike
   * {@link stopSession} — which keeps a warm ACP session pooled and only issues
   * a graceful cancel — this tears the runtime down (interrupt → close → hard
   * kill), so a stale ACP connection is replaced rather than reused on retry.
   */
  async discardSession(sessionId: string): Promise<void> {
    if (this.runtime.get(sessionId) === undefined) return;
    await this.runtime.stop(sessionId);
  }


  /** Tear down all sessions, cancel pending permissions, and stop the eviction timer. */
  shutdown(): void {
    this.getAcpClientBridge().cancelAllPending();
    for (const [sessionId, runtime] of this.pendingAcpRuntimes ?? []) {
      this.pendingStops.add(sessionId);
      void runtime.close();
    }
    for (const sessionId of this.liveSessionIds) {
      this.browserAutomationLease.releaseSession(this.id, sessionId);
    }
    void this.runtime.shutdown().catch((err: unknown) => {
      logger.warn("Cursor runtime shutdown failed", { error: String(err) });
    });
    this.sdkSessionIds.clear();
    this.liveSessionIds.clear();
    for (const stage of this.pendingBrowserLeases.values()) {
      this.browserAutomationLease.release(stage.leaseId);
    }
    for (const grant of this.pendingBrowserGrants.values()) {
      this.browserAutomationLease.release(grant.leaseId);
    }
    this.pendingBrowserLeases.clear();
    this.pendingBrowserContext.clear();
    this.pendingBrowserGrants.clear();
    this.pendingBrowserGrantContext.clear();
    logger.info("CursorProvider shutdown complete");
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.getAcpClientBridge().resolvePermission(requestId, decision);
  }

  listPendingPermissions(threadId: string): PermissionRequest[] {
    return this.getAcpClientBridge().listPendingPermissions(threadId);
  }

  /**
   * Invoked once the SkillWatcher debouncer finishes flushing filesystem events so
   * sticky Cursor preambles can pick up regenerated skill inventories.
   */
  onSkillRegistryDebouncedInvalidation(): void {
    for (const id of this.liveSessionIds) {
      const e = this.runtime.get(id);
      if (e) e.stickyHeavyInstructionsSent = false;
    }
  }

  /**
   * Spawns a fresh Cursor ACP session for the runtime: launches the
   * `cursor-agent acp` subprocess (probing CLI candidates), runs the ACP
   * `initialize`/`authenticate` handshake, then opens the logical ACP session
   * (`session/load` on resume, falling back to `session/new`). Returns the
   * child PID in `pids` so the runtime routes cleanup through the server process
   * port. The provider does not manage process trees inline.
   */
  async spawn(args: SpawnArgs): Promise<SpawnResult<CursorSessionState>> {
    const { sessionId, threadId, cwd, permissionMode, resumeFrom } = args;
    const pm: "full" | "default" = permissionMode === "full" ? "full" : "default";
    const settings = this.settingsService.get();
    const browserStage = this.pendingBrowserLeases.get(sessionId);
    const refreshedGrant = this.pendingBrowserGrants.get(sessionId);
    let browserGrant: BrowserAutomationSessionLeaseGrant | null = null;
    let state: CursorAcpSessionEntry | undefined;
    try {
      state = await this.spawnChild(sessionId, threadId, cwd, pm, settings);
      this.throwIfPendingStop(sessionId);
      browserGrant = this.resolveBrowserGrantForSpawn(
        sessionId,
        threadId,
        state,
        browserStage,
        refreshedGrant,
      );
      const mcpServers = buildCursorBrowserMcpServers(browserGrant);

      // Thread control is optional. Retry on a fresh ACP process without it so
      // a broken internal MCP cannot prevent a Cursor thread from starting.
      const opened = await this.openSessionWithOptionalThreadControl(
        state,
        resumeFrom !== undefined,
        mcpServers,
        settings,
      );
      state = opened.state;
      state.mcodeLogicalSessionReloaded = opened.reloaded;
      this.throwIfPendingStop(sessionId);
      this.configureSpawnedSession(state, threadId, browserGrant);
    } catch (error) {
      await this.cleanupSpawnFailure(sessionId, state, browserGrant, browserStage, refreshedGrant);
      await this.clearFailedSpawn(sessionId);
      throw error;
    }
    return this.completeSpawn(sessionId, state);
  }

  private throwIfPendingStop(sessionId: string): void {
    if (!this.pendingStops.has(sessionId)) return;
    throw new Error("Cursor ACP session stopped during startup");
  }

  private resolveBrowserGrantForSpawn(
    sessionId: string,
    threadId: string,
    state: CursorAcpSessionEntry,
    browserStage: BrowserAutomationSessionLeaseStage | undefined,
    refreshedGrant: BrowserAutomationSessionLeaseGrant | undefined,
  ): BrowserAutomationSessionLeaseGrant | null {
    if (state.browserHttpMcpSupported) {
      return this.resolveSupportedBrowserGrant(sessionId, browserStage, refreshedGrant);
    }

    this.releaseBrowserLeases(browserStage, refreshedGrant);
    this.browserAutomationLease.releaseSession(this.id, sessionId);
    this.pendingBrowserGrants.delete(sessionId);
    this.pendingBrowserGrantContext.delete(sessionId);
    if (browserStage) {
      logger.info("Cursor ACP does not advertise HTTP MCP; browser automation is unavailable", {
        threadId,
      });
    }
    return null;
  }

  private resolveSupportedBrowserGrant(
    sessionId: string,
    browserStage: BrowserAutomationSessionLeaseStage | undefined,
    refreshedGrant: BrowserAutomationSessionLeaseGrant | undefined,
  ): BrowserAutomationSessionLeaseGrant | null {
    if (refreshedGrant) {
      this.pendingBrowserGrants.delete(sessionId);
      this.pendingBrowserGrantContext.delete(sessionId);
      this.releaseBrowserLeases(browserStage);
      return refreshedGrant;
    }
    if (!browserStage) return null;

    const browserGrant = this.browserAutomationLease.issue(browserStage);
    if (!browserGrant) {
      throw new Error("Cursor browser automation lease issuance failed");
    }
    return browserGrant;
  }

  private configureSpawnedSession(
    state: CursorAcpSessionEntry,
    threadId: string,
    browserGrant: BrowserAutomationSessionLeaseGrant | null,
  ): void {
    state.mcodeRuntimeInstructions = renderMcodeInstructions(buildMcodeInstructionPlan({
      sourceThreadId: threadId,
      threadControlGranted: this.isThreadControlMcpEnabled(state),
      browserAutomationGranted: Boolean(browserGrant),
    }));
    state.mcodeRuntimeInstructionsSent = false;
    if (!browserGrant) return;

    state.browserCredential = {
      credentialId: browserGrant.credentialId,
      expiresAt: browserGrant.expiresAt,
      leaseId: browserGrant.leaseId,
    };
  }

  private async clearFailedSpawn(sessionId: string): Promise<void> {
    this.pendingStops.delete(sessionId);
    this.pendingAcpRuntimes.delete(sessionId);
    await this.threadControlMcp.close(sessionId);
  }

  private completeSpawn(
    sessionId: string,
    state: CursorAcpSessionEntry,
  ): SpawnResult<CursorSessionState> {
    this.pendingAcpRuntimes.delete(sessionId);
    this.liveSessionIds.add(sessionId);
    return { state, pids: state.child.pid != null ? [state.child.pid] : [] };
  }

  /** Eviction guard: a turn is in flight while `activeTurnState` is set. */
  isBusy(state: CursorSessionState): boolean {
    return state.activeTurnState != null;
  }

  /**
   * Graceful protocol interrupt: ACP `session/cancel` for the open logical
   * session. Does not kill the child — the runtime's hard kill handles the OS
   * process via the surfaced PID.
   */
  async interrupt(state: CursorSessionState): Promise<void> {
    state.pendingUserStopAbort = false;
    if (state.acpSessionId) {
      await state.acpRuntime.cancel().catch(() => {});
    }
  }

  /**
   * Provider teardown that is not the OS kill: cancel any pending permissions
   * for this session (so orphaned approval cards clear) and drop it from the
   * live-id mirror. The child process is killed by the runtime's hard kill.
   */
  async close(state: CursorSessionState): Promise<void> {
    this.getAcpClientBridge().cancelPendingForSession(state.mcodeSessionId);
    this.liveSessionIds.delete(state.mcodeSessionId);
    if (!this.pendingBrowserGrants.has(state.mcodeSessionId) && !this.pendingBrowserLeases.has(state.mcodeSessionId)) {
      this.browserAutomationLease.releaseSession(this.id, state.mcodeSessionId);
    }
    await this.threadControlMcp?.close(state.mcodeSessionId);
  }

  private sameBrowserContext(left: CursorBrowserContext, right: CursorBrowserContext): boolean {
    return left.workspaceId === right.workspaceId &&
      left.browserPermissionCapability === right.browserPermissionCapability;
  }

  private releaseBrowserLeases(...leases: Array<{ leaseId: string } | null | undefined>): void {
    const released = new Set<string>();
    for (const lease of leases) {
      if (!lease || released.has(lease.leaseId)) continue;
      released.add(lease.leaseId);
      this.browserAutomationLease.release(lease.leaseId);
    }
  }

  private async cleanupSpawnFailure(
    sessionId: string,
    state: CursorAcpSessionEntry | undefined,
    ...leases: Array<{ leaseId: string } | null | undefined>
  ): Promise<void> {
    this.releaseBrowserLeases(...leases);
    this.browserAutomationLease.releaseSession(this.id, sessionId);
    this.pendingBrowserLeases.delete(sessionId);
    this.pendingBrowserContext.delete(sessionId);
    this.pendingBrowserGrants.delete(sessionId);
    this.pendingBrowserGrantContext.delete(sessionId);
    this.liveSessionIds.delete(sessionId);
    await state?.acpRuntime?.close();
  }

  /** A pooled session must be discarded before reuse if the child died or the cwd/permission mode changed. */
  isStale(state: CursorSessionState, args: { cwd: string; permissionMode: string }): boolean {
    const dead = state.child.exitCode != null || state.child.signalCode != null;
    if (dead) return true;
    const pm: "full" | "default" = args.permissionMode === "full" ? "full" : "default";
    return state.permissionMode !== pm || state.cwd !== args.cwd;
  }

  private async spawnChild(
    mcodeSessionId: string,
    threadId: string,
    cwd: string,
    permissionMode: "full" | "default",
    settings: Settings,
  ): Promise<CursorAcpSessionEntry> {
    return this.getProcessSpawner().spawn(
      mcodeSessionId,
      threadId,
      cwd,
      permissionMode,
      settings,
    );
  }

  private isThreadControlMcpEnabled(entry: CursorAcpSessionEntry): boolean {
    return entry.supportsHttpMcp && entry.threadControlMcpEnabled !== false;
  }

  private async openSessionWithOptionalThreadControl(
    initialState: CursorAcpSessionEntry,
    resume: boolean,
    mcpServers: McpServer[],
    settings: Settings,
  ): Promise<{ state: CursorAcpSessionEntry; reloaded: boolean }> {
    try {
      return {
        state: initialState,
        reloaded: await this.openLogicalSession(initialState, resume, mcpServers),
      };
    } catch (error) {
      if (!this.isThreadControlMcpEnabled(initialState)) throw error;

      logger.warn("Cursor thread-control MCP prevented session startup; retrying without it", {
        threadId: initialState.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.disableThreadControlMcp(initialState);
      const fallbackState = await this.spawnChild(
        initialState.mcodeSessionId,
        initialState.threadId,
        initialState.cwd,
        initialState.permissionMode,
        settings,
      );
      fallbackState.threadControlMcpEnabled = false;
      try {
        return {
          state: fallbackState,
          reloaded: await this.openLogicalSession(fallbackState, resume, mcpServers),
        };
      } catch (fallbackError) {
        await fallbackState.acpRuntime.close();
        throw fallbackError;
      }
    }
  }

  private async disableThreadControlMcp(entry: CursorAcpSessionEntry): Promise<void> {
    entry.threadControlMcpEnabled = false;
    try {
      await this.threadControlMcp.close(entry.mcodeSessionId);
    } catch (error) {
      logger.warn("Cursor thread-control MCP cleanup failed", {
        threadId: entry.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async openThreadControlMcp(
    entry: CursorAcpSessionEntry,
  ): Promise<ProviderThreadControlHttpConnection | undefined> {
    if (!this.isThreadControlMcpEnabled(entry)) return undefined;

    try {
      const connection = await this.threadControlMcp.createHttpConnection(entry.mcodeSessionId);
      if (connection) return connection;
      logger.warn("Cursor thread-control MCP is unavailable; continuing without it", {
        threadId: entry.threadId,
      });
    } catch (error) {
      logger.warn("Cursor thread-control MCP setup failed; continuing without it", {
        threadId: entry.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await this.disableThreadControlMcp(entry);
    return undefined;
  }

  /** Ensures `entry.acpSessionId` is ready (new or load). */
  private async openLogicalSession(
    entry: CursorAcpSessionEntry,
    resume: boolean,
    mcpServers: McpServer[] = [],
  ): Promise<boolean> {
    if (entry.acpSessionId) return true;

    const stored = this.sdkSessionIds.get(entry.mcodeSessionId);
    const internalMcp = await this.openThreadControlMcp(entry);
    const effectiveMcpServers = [
      ...(internalMcp ? buildCursorInternalMcpServers(internalMcp) : []),
      ...mcpServers,
    ];
    const opened = await entry.acpRuntime.openSession({
      resumeFrom: resume ? stored : undefined,
      cwd: entry.cwd,
      mcpServers: effectiveMcpServers,
    });
    entry.acpSessionId = opened.sessionId;
    this.sdkSessionIds.set(entry.mcodeSessionId, opened.sessionId);
    this.publishCursorEvent(this.turnRoutingForEntry(entry), {
      type: AgentEventType.System,
      threadId: entry.threadId,
      subtype: `sdk_session_id:${opened.sessionId}`,
    } satisfies AgentEvent, this.acpSessionIdentities(entry));
    return opened.reloaded;
  }

  private async applyModel(entry: CursorAcpSessionEntry, model: string): Promise<void> {
    const trimmed = model.trim();
    if (!trimmed || !entry.acpSessionId) return;

    const paired = entry.cursorModelAppliedPair;
    if (
      paired &&
      paired.acpSessionId === entry.acpSessionId &&
      paired.modelId === trimmed
    ) {
      return;
    }

    try {
      await entry.connection.unstable_setSessionModel({
        sessionId: entry.acpSessionId,
        modelId: trimmed,
      });
      entry.cursorModelAppliedPair = { acpSessionId: entry.acpSessionId, modelId: trimmed };
    } catch (err: unknown) {
      entry.cursorModelAppliedPair = null;
      logger.debug("Cursor ACP setSessionModel noop", {
        threadId: entry.threadId,
        error: String(err),
      });
    }
  }

  /** Respawns `cursor-agent acp` after an unexpected disconnect and preserves turn pacing state. */
  private async respawnCursorSessionAfterAcpClose(
    dead: CursorAcpSessionEntry,
  ): Promise<CursorAcpSessionEntry> {
    const sessionId = dead.mcodeSessionId;
    this.logAcpChildDisconnect(dead, "ACP connection closed");
    await this.runtime.stop(sessionId);
    const browserStage = this.browserAutomationLease.isConfigured() && dead.browserHttpMcpSupported
      ? this.browserAutomationLease.stage({
        providerId: this.id,
        providerSessionId: this.sdkSessionIds.get(sessionId) ?? sessionId,
        mcodeSessionId: sessionId,
        threadId: dead.threadId,
        workspaceId: dead.workspaceId,
        permissionCapability: dead.browserPermissionCapability,
      })
      : undefined;
    if (browserStage) {
      this.pendingBrowserLeases.set(sessionId, browserStage);
      this.pendingBrowserContext.set(sessionId, {
        workspaceId: dead.workspaceId,
        browserPermissionCapability: dead.browserPermissionCapability,
      });
    }
    let fresh: CursorAcpSessionEntry;
    try {
      fresh = await this.runtime.acquire({
        sessionId,
        threadId: dead.threadId,
        cwd: dead.cwd,
        permissionMode: dead.permissionMode,
        resumeFrom: this.sdkSessionIds.get(sessionId),
      });
    } catch (error) {
      if (browserStage) this.browserAutomationLease.release(browserStage.leaseId);
      this.pendingBrowserLeases.delete(sessionId);
      this.pendingBrowserContext.delete(sessionId);
      throw error;
    }
    this.pendingBrowserLeases.delete(sessionId);
    this.pendingBrowserContext.delete(sessionId);
    fresh.stickyHeavyInstructionsSent = dead.stickyHeavyInstructionsSent;
    fresh.cursorPromptOrdinal = dead.cursorPromptOrdinal;
    fresh.mcodeRuntimeInstructionsSent = carryCursorMcodeSentState(
      fresh.mcodeLogicalSessionReloaded,
      dead.mcodeRuntimeInstructionsSent,
    );
    fresh.lastUsedAt = Date.now();
    logger.info("Cursor ACP subprocess respawned after disconnect", {
      threadId: fresh.threadId,
      acpSessionId: this.sdkSessionIds.get(sessionId),
      childPid: fresh.child.pid,
    });
    return fresh;
  }

  /** Logs child exit metadata when the ACP stdio stream closes mid-turn. */
  private logAcpChildDisconnect(entry: CursorAcpSessionEntry, error: string): void {
    const cursorCfg = this.settingsService.get().provider.cursor;
    const stderrTail =
      cursorCfg.verboseFailureLogs && entry.stderrTailLines.length > 0
        ? entry.stderrTailLines.slice(-16)
        : undefined;
    logger.warn("Cursor ACP connection closed mid-turn", {
      threadId: entry.threadId,
      acpSessionId: entry.acpSessionId,
      promptOrdinal: entry.cursorPromptOrdinal,
      childPid: entry.child.pid,
      childExitCode: entry.child.exitCode,
      childSignalCode: entry.child.signalCode,
      verboseFailureLogs: cursorCfg.verboseFailureLogs,
      stderrTail,
      error,
    });
  }

  private async runTurn(
    entry: CursorAcpSessionEntry,
    opts: Parameters<CursorTurnExecutor["run"]>[1],
  ): Promise<void> {
    return this.getTurnExecutor().run(entry, opts);
  }

  /** Runs an isolated path-B summary query against a persisted Cursor session. */
  async runSideChannelQuery(args: {
    parentThreadId: string;
    parentSdkSessionId: string;
    prompt: string;
    abortSignal?: AbortSignal;
    conversationHistory?: string;
    cwd: string;
  }): Promise<string> {
    return this.getSideChannel().run(args);
  }
}
