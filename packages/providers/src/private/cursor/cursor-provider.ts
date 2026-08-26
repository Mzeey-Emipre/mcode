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
  readonly sessionForkOnResume = "clean" as const;
  readonly maxInputCharactersPerTurn = 4_000;
  /** Path B forker; calls this provider's runSideChannelQuery on a forked copy of the parent session. */
  readonly forker = new CursorCleanForker(this);

  /** Owns the session pool, idle eviction, and server-managed process cleanup. */
  private readonly runtime: SessionRuntime<CursorSessionState>;
  private sdkSessionIds = new Map<string, string>();
  /** Binds each ACP prompt state to its immutable originating Mcode execution. */
  private readonly turnExecutionByState = new WeakMap<object, string>();
  /** Binds a request that is still opening to its Mcode execution for stop teardown. */
  private readonly pendingTurnExecutionIds = new Map<string, string>();
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
        emitEvent: (event) => this.emit("event", event),
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
        turnExecutionId: (entry) => entry.activeTurnState
          ? this.turnExecutionByState.get(entry.activeTurnState)
          : undefined,
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
        emitEvent: (event) => this.emit("event", event),
        bindTurnExecution: (entry, turnExecutionId) => {
          if (entry.activeTurnState) {
            this.turnExecutionByState.set(entry.activeTurnState, turnExecutionId);
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
    void req.fallbackModel;
    void req.reasoningLevel;

    const {
      sessionId,
      message,
      cwd,
      model,
      permissionMode,
      attachments,
    } = req;
    // `resumeFrom` defined ⇒ resume the stored ACP session; undefined ⇒ fresh.
    const resume = req.resumeFrom !== undefined;
    if (req.resumeFrom !== undefined) {
      this.sdkSessionIds.set(sessionId, req.resumeFrom);
    }

    const threadId = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
    this.pendingTurnExecutionIds.set(sessionId, req.turnExecutionId);
    const emitTurnEvent = (event: AgentEvent): void => { this.emit("event", { ...event, turnExecutionId: req.turnExecutionId }); };
    const browserPermissionCapability = providerBrowserPermissionCapability(
      permissionMode,
      req.interactionMode,
    );
    const browserContext: CursorBrowserContext = {
      workspaceId: req.workspaceId,
      browserPermissionCapability,
    };

    this.getAcpClientBridge().setPlanQuestionMode(threadId, req.interactionMode === "plan");

    let existing = this.runtime.get(sessionId);
    const pendingGrant = this.pendingBrowserGrants.get(sessionId);
    const pendingGrantContext = this.pendingBrowserGrantContext.get(sessionId);
    if (pendingGrant && (!pendingGrantContext || !this.sameBrowserContext(pendingGrantContext, browserContext))) {
      this.releaseBrowserLeases(pendingGrant);
      this.pendingBrowserGrants.delete(sessionId);
      this.pendingBrowserGrantContext.delete(sessionId);
    }
    // ACP callbacks are connection-scoped and carry no prompt id. Rotate a
    // completed session before the next logical turn so late notifications
    // stay bound to the old connection's immutable execution state.
    if (existing && existing.activeTurnState === null && existing.cursorPromptOrdinal > 0) {
      await this.runtime.stop(sessionId);
      existing = undefined;
    }
    let browserStage: BrowserAutomationSessionLeaseStage | undefined;
    if (existing) {
      const browserContextChanged =
        existing.workspaceId !== req.workspaceId ||
        existing.browserPermissionCapability !== browserPermissionCapability;
      const browserExpired = existing.browserCredential !== undefined &&
        existing.browserCredential.expiresAt <= Date.now();
      const acquireWillReplace = this.isStale(existing, { cwd, permissionMode });
      if (browserContextChanged || browserExpired || acquireWillReplace) {
        if (!browserContextChanged && browserExpired && existing.browserCredential) {
          const refreshed = this.browserAutomationLease.refresh(existing.browserCredential.leaseId);
          if (refreshed.ok) {
            this.pendingBrowserGrants.set(sessionId, refreshed.grant);
            this.pendingBrowserGrantContext.set(sessionId, browserContext);
            existing.browserCredential = undefined;
          }
        }
        if (acquireWillReplace && !this.pendingBrowserGrants.has(sessionId)) {
          browserStage = this.pendingBrowserLeases.get(sessionId);
          const stagedContext = this.pendingBrowserContext.get(sessionId);
          if (browserStage && (!stagedContext || !this.sameBrowserContext(stagedContext, browserContext))) {
            this.releaseBrowserLeases(browserStage);
            this.pendingBrowserLeases.delete(sessionId);
            this.pendingBrowserContext.delete(sessionId);
            browserStage = undefined;
          }
          if (this.browserAutomationLease.isConfigured() && !browserStage) {
            browserStage = this.browserAutomationLease.stage({
              providerId: this.id,
              providerSessionId: req.resumeFrom ?? sessionId,
              mcodeSessionId: sessionId,
              threadId: req.threadId,
              workspaceId: req.workspaceId,
              permissionCapability: browserPermissionCapability,
            });
            this.pendingBrowserLeases.set(sessionId, browserStage);
            this.pendingBrowserContext.set(sessionId, browserContext);
          }
        }
        await this.runtime.stop(sessionId);
      }
    }
    if (!this.runtime.get(sessionId)) {
      if (this.pendingBrowserGrants.has(sessionId)) {
        const staleStage = this.pendingBrowserLeases.get(sessionId);
        this.releaseBrowserLeases(staleStage);
        this.pendingBrowserLeases.delete(sessionId);
        this.pendingBrowserContext.delete(sessionId);
      } else {
        browserStage = this.pendingBrowserLeases.get(sessionId);
        const stagedContext = this.pendingBrowserContext.get(sessionId);
        if (browserStage && (!stagedContext || !this.sameBrowserContext(stagedContext, browserContext))) {
          this.releaseBrowserLeases(browserStage);
          this.pendingBrowserLeases.delete(sessionId);
          this.pendingBrowserContext.delete(sessionId);
          browserStage = undefined;
        }
      }
      if (
        this.browserAutomationLease.isConfigured() &&
        !browserStage &&
        !this.pendingBrowserGrants.has(sessionId)
      ) {
        browserStage = this.browserAutomationLease.stage({
          providerId: this.id,
          providerSessionId: req.resumeFrom ?? sessionId,
          mcodeSessionId: sessionId,
          threadId: req.threadId,
          workspaceId: req.workspaceId,
          permissionCapability: browserPermissionCapability,
        });
        this.pendingBrowserLeases.set(sessionId, browserStage);
        this.pendingBrowserContext.set(sessionId, browserContext);
      }
    }

    let entry: CursorSessionState;
    try {
      // The runtime discards a stale pooled session (dead child / cwd /
       // permission-mode mismatch, see `isStale`) and spawns a fresh one.
       // The server process port owns the returned child PID.
      entry = await this.runtime.acquire({
        sessionId,
        threadId,
        cwd,
        permissionMode,
        resumeFrom: resume ? this.sdkSessionIds.get(sessionId) : undefined,
      });
    } catch (err) {
      this.releaseBrowserLeases(browserStage);
      this.pendingBrowserLeases.delete(sessionId);
      this.pendingBrowserContext.delete(sessionId);
      const refreshed = this.pendingBrowserGrants.get(sessionId);
      this.releaseBrowserLeases(refreshed);
      this.pendingBrowserGrants.delete(sessionId);
      this.pendingBrowserGrantContext.delete(sessionId);
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("Cursor ACP spawn failed", { sessionId, error: errMsg });
      emitTurnEvent({ type: AgentEventType.Error, threadId, error: errMsg } satisfies AgentEvent);
      emitTurnEvent({ type: AgentEventType.Ended, threadId, turnExecutionId: req.turnExecutionId } satisfies AgentEvent);
      if (this.pendingTurnExecutionIds.get(sessionId) === req.turnExecutionId) {
        this.pendingTurnExecutionIds.delete(sessionId);
      }
      return;
    }
    this.pendingBrowserLeases.delete(sessionId);
    this.pendingBrowserContext.delete(sessionId);
    if (browserStage && entry === existing) this.releaseBrowserLeases(browserStage);

    // A stop requested before the session finished spawning: tear it down now.
    if (this.pendingStops.delete(sessionId)) {
      logger.info("Pending stop consumed, tearing down new Cursor session", { sessionId });
      void this.runtime.stop(sessionId);
      emitTurnEvent({ type: AgentEventType.Ended, threadId, turnExecutionId: req.turnExecutionId } satisfies AgentEvent);
      if (this.pendingTurnExecutionIds.get(sessionId) === req.turnExecutionId) {
        this.pendingTurnExecutionIds.delete(sessionId);
      }
      return;
    }

    this.runtime.recordUsage(sessionId);
    entry.lastUsedAt = Date.now();
    const scheduled = entry.turnChain.then(() =>
      this.runTurn(entry, { message, model, resume, attachments, turnExecutionId: req.turnExecutionId }),
    );
    entry.turnChain = scheduled.then(
      () => {},
      () => {},
    );
    try {
      await scheduled;
    } finally {
      if (this.pendingTurnExecutionIds.get(sessionId) === req.turnExecutionId) {
        this.pendingTurnExecutionIds.delete(sessionId);
      }
    }
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
    if (entry?.acpSessionId && entry.activeTurnState) {
      entry.pendingUserStopAbort = true;
    }
    if (entry?.acpSessionId) {
      await entry.acpRuntime.cancel().catch(() => {});
    } else if (entry) {
      // Entry exists but ACP session hasn't opened yet; tear down immediately.
      const threadId = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
      const turnExecutionId = entry.activeTurnState
        ? this.turnExecutionByState.get(entry.activeTurnState)
        : this.pendingTurnExecutionIds.get(sessionId);
      await this.runtime.stop(sessionId);
      if (turnExecutionId) {
        this.emit("event", { type: AgentEventType.Ended, threadId, turnExecutionId } satisfies AgentEvent);
      }
    } else if (this.pendingAcpRuntimes?.has(sessionId)) {
      this.pendingStops.add(sessionId);
      await this.pendingAcpRuntimes?.get(sessionId)?.close();
    } else {
      this.pendingStops.add(sessionId);
      setTimeout(() => this.pendingStops.delete(sessionId), 10_000);
    }
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
      if (this.pendingStops?.has(sessionId)) {
        throw new Error("Cursor ACP session stopped during startup");
      }
      if (state.browserHttpMcpSupported) {
        if (refreshedGrant) {
          browserGrant = refreshedGrant;
          this.pendingBrowserGrants.delete(sessionId);
          this.pendingBrowserGrantContext.delete(sessionId);
          if (browserStage) this.releaseBrowserLeases(browserStage);
        } else if (browserStage) {
          browserGrant = this.browserAutomationLease.issue(browserStage);
          if (!browserGrant) {
            throw new Error("Cursor browser automation lease issuance failed");
          }
        }
      } else {
        this.releaseBrowserLeases(browserStage, refreshedGrant);
        this.browserAutomationLease.releaseSession(this.id, sessionId);
        this.pendingBrowserGrants.delete(sessionId);
        this.pendingBrowserGrantContext.delete(sessionId);
      }
      if (browserStage && !state.browserHttpMcpSupported) {
        logger.info("Cursor ACP does not advertise HTTP MCP; browser automation is unavailable", {
          threadId,
        });
      }
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
      if (this.pendingStops?.has(sessionId)) {
        throw new Error("Cursor ACP session stopped during startup");
      }
      state.mcodeRuntimeInstructions = renderMcodeInstructions(buildMcodeInstructionPlan({
        sourceThreadId: threadId,
        threadControlGranted: this.isThreadControlMcpEnabled(state),
        browserAutomationGranted: Boolean(browserGrant),
      }));
      state.mcodeRuntimeInstructionsSent = false;
      if (browserGrant) {
        state.browserCredential = {
          credentialId: browserGrant.credentialId,
          expiresAt: browserGrant.expiresAt,
          leaseId: browserGrant.leaseId,
        };
      }
    } catch (err) {
      await this.cleanupSpawnFailure(sessionId, state, browserGrant, browserStage, refreshedGrant);
      this.pendingStops?.delete(sessionId);
      this.pendingAcpRuntimes?.delete(sessionId);
      await this.threadControlMcp?.close(sessionId);
      throw err;
    }

    this.pendingAcpRuntimes?.delete(sessionId);
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
    this.emit("event", {
      type: AgentEventType.System,
      threadId: entry.threadId,
      subtype: `sdk_session_id:${opened.sessionId}`,
    } satisfies AgentEvent);
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
