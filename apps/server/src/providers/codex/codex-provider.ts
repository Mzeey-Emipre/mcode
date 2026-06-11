/**
 * Codex provider adapter using the persistent `codex app-server` subprocess.
 *
 * Each session owns one `CodexAppServer` process that stays alive between turns.
 * JSON-RPC 2.0 notifications are translated to `AgentEvent` objects by
 * `CodexEventMapper` and forwarded to subscribers via EventEmitter.
 *
 * Turn lifecycle:
 *   sendMessage → server.sendTurn → notifications stream in → turn.completed/failed
 */

import { injectable, inject } from "tsyringe";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { logger } from "@mcode/shared";
import { SettingsService } from "../../services/settings-service.js";
import { JobObject } from "../../services/job-object.js";
import { EnvService } from "../../services/env-service.js";
import { SessionRuntime } from "../../services/session-runtime.js";
import type { ProtocolAdapter, SpawnArgs, SpawnResult } from "../../services/session-runtime.js";
import { DeterministicForker } from "../../services/handoff/session-forker.js";
import type {
  IAgentProvider,
  ISessionEvictable,
  SessionForker,
  TurnRequest,
  ProviderId,
  ReasoningLevel,
  AgentEvent,
  AttachmentMeta,
  PermissionDecision,
  PermissionRequest,
  ProviderModelInfo,
} from "@mcode/contracts";
import { AgentEventType, CODEX_STATIC_MODELS, isVirtualBrowserContextAttachment } from "@mcode/contracts";
import { checkCodexVersion, meetsMinVersion } from "./codex-version.js";
import { CodexAppServer } from "./codex-app-server.js";
import type { CodexApprovalRequest } from "./codex-app-server.js";
import { CodexEventMapper } from "./codex-event-mapper.js";
import { traceCodexIngest } from "./codex-trace.js";
import {
  mapDecisionToCodexResponse,
  synthesizeCodexPermissionRequest,
} from "./codex-permission-mapper.js";
import type { TurnInputPart, CodexNotification, CodexTurnOptions, ReasoningEffort } from "./codex-types.js";

/**
 * Liveness-probe interval for a silent turn, not a turn deadline. The timer
 * resets on every notification (including swallowed lifecycle traffic and
 * inbound approval requests, via the app-server `activity` event). When a
 * turn stays fully silent for this long, the watchdog pings the app-server
 * with a cheap RPC: responsive → re-arm (a healthy turn can run forever);
 * unresponsive → end the turn so the session does not stay `isBusy` (exempt
 * from idle eviction) with the UI stuck "thinking" indefinitely. While a
 * permission approval awaits the user, the watchdog re-arms without probing.
 */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

/** Internal: a newer `sendMessage` aborted this turn wait (not user-facing). */
class CodexTurnSupersededError extends Error {
  constructor() {
    super("Codex turn superseded");
    this.name = "CodexTurnSupersededError";
  }
}

/** Internal: silent turn AND the app-server failed a liveness probe; ends the turn without a user error. */
class CodexTurnIdleTimeoutError extends Error {
  constructor() {
    super(
      `Codex turn abandoned: no notifications for ${TURN_TIMEOUT_MS / 1000}s and the app-server failed a liveness probe`,
    );
    this.name = "CodexTurnIdleTimeoutError";
  }
}

/**
 * Per-session state owned by the {@link SessionRuntime}. Holds the live
 * app-server, its event mapper, and the turn-sequencing bookkeeping that the
 * provider's `runTurn` reads. The runtime owns eviction timing, but
 * `lastUsedAt` is retained here because `resolvePermission` stamps it so user
 * attention on a permission card counts as activity.
 */
interface CodexSessionState {
  /** Session id this state belongs to; lets `close`/drain reference provider-owned maps. */
  sessionId: string;
  /** Thread id derived from the session id; reused for event emission on teardown. */
  threadId: string;
  server: CodexAppServer;
  mapper: CodexEventMapper;
  lastUsedAt: number;
  /** Sandbox mode used when this session was started; used to detect permission mode changes. */
  sandboxMode: string;
  /** Monotonic counter so overlapping `runTurn` waits ignore stale completions. */
  runTurnSeq: number;
  /** Codex `turn.id` from the latest `turn/started` for this session. */
  pendingTurnId: string | null;
  /** Clears the in-flight `runTurn` listener when a new turn preempts it. */
  abortPendingTurnWait?: () => void;
}

/** One pending codex approval bridged into the Phase 1 permission flow. */
interface PendingPermissionEntry {
  sessionId: string;
  threadId: string;
  toolName: string;
  input: unknown;
  title?: string;
  method: string;
  params: Record<string, unknown>;
  resolve: (response: unknown) => void;
}

/**
 * Builds the Codex turn input from a message string and optional attachments.
 * Images become `localImage` parts; non-image files become sanitised text notes
 * that omit internal filesystem paths to prevent prompt injection.
 */
function buildCodexInput(
  message: string,
  attachments?: AttachmentMeta[],
): TurnInputPart[] {
  const inputs: TurnInputPart[] = [];

  for (const att of attachments ?? []) {
    if (isVirtualBrowserContextAttachment(att.mimeType)) continue;
    if (att.mimeType.startsWith("image/")) {
      inputs.push({ type: "localImage", path: att.sourcePath });
    } else {
      // Strip control characters (including newlines) from user-supplied strings
      // to prevent prompt injection. Do not expose internal filesystem paths.
      const safeName = att.name.replace(/[\x00-\x1f\x7f]/g, "");
      const safeMime = att.mimeType.replace(/[\x00-\x1f\x7f]/g, "");
      inputs.push({ type: "text", text: `[Attached file: ${safeName} (${safeMime})]` });
    }
  }

  inputs.push({ type: "text", text: message });
  return inputs;
}

/** Maps mcode ReasoningLevel to the codex app-server `effort` field value. */
function toCodexEffort(level?: ReasoningLevel): ReasoningEffort | undefined {
  if (!level) return undefined;
  if (level === "max" || level === "ultrathink") return "high";
  return level as ReasoningEffort;
}

/** Codex provider adapter implementing IAgentProvider with a persistent app-server process per session. */
@injectable()
export class CodexProvider extends EventEmitter implements IAgentProvider, ISessionEvictable, ProtocolAdapter<CodexSessionState> {
  readonly id: ProviderId = "codex";
  /** Codex CLI is an agentic tool with no one-shot text completion mode. */
  readonly supportsCompletion = false;
  readonly sessionForkOnResume = "unsupported" as const;
  readonly maxInputCharactersPerTurn = 16_000;
  /** Path D forker; Codex cannot fork a session, so handoffs are deterministic. */
  readonly forker: SessionForker = new DeterministicForker();

  /** Returns the static Codex model catalog. Codex does not support dynamic model discovery. */
  async listModels(): Promise<ProviderModelInfo[]> {
    return CODEX_STATIC_MODELS.map((m) => ({ ...m }));
  }

  /** Owns the session pool, idle eviction (with busy guard), and JobObject/kill. */
  private readonly runtime: SessionRuntime<CodexSessionState>;
  private sdkSessionIds = new Map<string, string>();
  /**
   * Session IDs for which a stop was requested before the session was created.
   * Checked after session creation; if found the session is torn down immediately.
   */
  private pendingStops = new Set<string>();
  /** Pending host-side permission approvals keyed by requestId. */
  private pendingPermissions = new Map<string, PendingPermissionEntry>();
  /**
   * Turn input + options carried from `sendTurn` to `spawn` so a freshly
   * spawned session can run its first turn. The runtime's `acquire` only hands
   * back the state, so the per-turn payload is staged here keyed by sessionId.
   */
  private pendingSpawnTurns = new Map<
    string,
    { input: string | TurnInputPart[]; turnOptions: CodexTurnOptions }
  >();

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
    @inject("JobObject") private readonly jobObject: JobObject,
    @inject(EnvService) private readonly envService: EnvService,
  ) {
    super();
    this.runtime = new SessionRuntime<CodexSessionState>(this, {
      jobObject: this.jobObject,
      envService: this.envService,
    });
  }

  /**
   * Starts or continues a session by sending a message to the Codex app-server.
   * For new sessions, spawns a subprocess and runs the JSON-RPC handshake first.
   * The method returns immediately; events stream via the `event` EventEmitter channel.
   */
  async sendTurn(req: TurnRequest<"codex">): Promise<void> {
    const settings = await this.settingsService.get();
    const cliPath = settings.provider.cli.codex || "codex";

    // `resumeFrom` defined ⇒ resume that Codex thread; undefined ⇒ fresh.
    if (req.resumeFrom !== undefined) {
      this.sdkSessionIds.set(req.sessionId, req.resumeFrom);
    }
    const {
      sessionId, message, cwd, model, permissionMode,
      reasoningLevel, attachments,
    } = req;
    const codexFastMode = req.providerOptions.fastMode;

    const input = buildCodexInput(message, attachments);
    const threadId = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;

    const sandbox = permissionMode === "full" ? "danger-full-access" : "workspace-write";

    const useFastTier =
      codexFastMode !== undefined
        ? codexFastMode
        : settings.provider.codex?.fastMode === true;
    // The app-server's model/list advertises the fast tier with id "priority"
    // (display name "Fast"). Sending "fast" is silently ignored upstream, so
    // fast mode had no effect. Only some models (e.g. gpt-5.4 / gpt-5.5)
    // expose the tier; the server falls back to standard for the rest.
    const fastServiceTier = useFastTier ? "priority" : undefined;

    const turnOptions = {
      model: model || undefined,
      effort: toCodexEffort(reasoningLevel),
      ...(fastServiceTier && { serviceTier: fastServiceTier }),
    };

    // Permission-mode change requires a fresh thread, not just a respawn: the
    // resumed thread would inherit the old sandbox. Clearing the stored SDK
    // thread ID and draining the stale session is Codex-specific bookkeeping
    // the runtime cannot do, so handle it here before acquiring.
    const existing = this.runtime.get(sessionId);
    if (existing && existing.server.isAlive && existing.sandboxMode !== sandbox) {
      logger.info("Codex session restarted due to permission mode change", {
        sessionId,
        from: existing.sandboxMode,
        to: sandbox,
      });
      // Drain synchronously here (not only via close()) so approval cards
      // clear deterministically even if the version check below aborts before
      // `acquire` discards the stale session. The app-server's graceful exit
      // suppresses the "fatal" emit, so the fatal-drain listener will not fire.
      this.drainPending((e) => e.sessionId === sessionId);
      // Clear the stored SDK thread id so the respawn starts a fresh thread
      // rather than resuming the old one (which would inherit the old sandbox).
      this.sdkSessionIds.delete(sessionId);
      // Eagerly tear the stale session down so a later abort (e.g. a failed
      // version check below) cannot leave a wrong-sandbox process alive.
      // `acquire` then spawns fresh. Fire-and-forget: permissions are already
      // drained above, so the async close has nothing left to resolve.
      void this.runtime.stop(sessionId).catch((err: unknown) => {
        logger.warn("Codex session kill on permission change failed", { error: String(err) });
      });
    }

    // Version check only when starting a new session (cached in codex-version
    // per CLI path). Reusing a live, mode-matched session skips this. Emit
    // user-facing errors and abort before touching the runtime so a bad CLI
    // never spawns a child.
    const reusable = existing && existing.server.isAlive && existing.sandboxMode === sandbox;
    if (!reusable) {
      const versionResult = checkCodexVersion(cliPath);
      if (!versionResult.ok) {
        this.emit("event", { type: AgentEventType.Error, threadId, error: versionResult.error } satisfies AgentEvent);
        this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
        return;
      }

      if (!meetsMinVersion(versionResult.version, "0.37.0")) {
        const errorMsg = `Codex CLI version ${versionResult.version} is not supported. Minimum required: 0.37.0. Update with: npm install -g @openai/codex`;
        this.emit("event", { type: AgentEventType.Error, threadId, error: errorMsg } satisfies AgentEvent);
        this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
        return;
      }
    }

    // Stage the per-turn payload so `spawn` can run the first turn of a fresh
    // session; reuse reads it directly below. Keyed by sessionId.
    this.pendingSpawnTurns.set(sessionId, { input, turnOptions });

    let state: CodexSessionState;
    try {
      state = await this.runtime.acquire({
        sessionId,
        threadId,
        cwd,
        permissionMode,
        resumeFrom:
          req.resumeFrom !== undefined ? this.sdkSessionIds.get(sessionId) : undefined,
      });
    } catch (e: unknown) {
      this.pendingSpawnTurns.delete(sessionId);
      const errorMessage = e instanceof Error ? e.message : String(e);
      logger.error("CodexAppServer start failed", { sessionId, error: errorMessage });
      this.emit("event", { type: AgentEventType.Error, threadId, error: errorMessage } satisfies AgentEvent);
      this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      return;
    }
    this.runtime.recordUsage(sessionId);

    // A stop requested before the session finished spawning: tear it down now.
    if (this.pendingStops.delete(sessionId)) {
      logger.info("Pending stop consumed, tearing down new Codex session", { sessionId });
      this.pendingSpawnTurns.delete(sessionId);
      void this.runtime.stop(sessionId);
      this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      return;
    }

    // Reuse path: `spawn` did not run because the session already existed, so
    // the staged turn is still pending. Reset the mapper and run it here.
    if (reusable && this.pendingSpawnTurns.delete(sessionId)) {
      state.lastUsedAt = Date.now();
      void this.runTurn(sessionId, threadId, state.server, input, turnOptions);
      return;
    }
  }

  /**
   * Spawns a fresh Codex app-server session: version-checked CLI launch, the
   * JSON-RPC handshake, mapper + event wiring, and the first turn for the
   * staged payload. Returns an empty `pids` array because {@link CodexAppServer}
   * keeps its child PID private and attaches it to the Windows JobObject
   * itself; the runtime's JobObject/taskkill are therefore best-effort no-ops
   * for Codex and teardown is delegated to `server.kill()` in {@link close}.
   */
  async spawn(args: SpawnArgs): Promise<SpawnResult<CodexSessionState>> {
    const settings = await this.settingsService.get();
    const cliPath = settings.provider.cli.codex || "codex";
    const { sessionId, threadId, cwd, permissionMode, resumeFrom } = args;

    const sandbox = permissionMode === "full" ? "danger-full-access" : "workspace-write";
    const approvalPolicy = permissionMode === "full" ? "never" : "on-request";

    const attemptResume = !!resumeFrom;

    // Only register the handler in supervised mode. The CodexAppServer
    // ignores approvalHandler when approvalPolicy === "never" (auto-approve
    // still runs locally), so this guard is defensive and keeps the wiring
    // obvious in logs.
    const supervised = approvalPolicy === "on-request";

    const server = new CodexAppServer({
      cliPath,
      workingDirectory: cwd,
      // The model passed at thread/start is carried on the turn payload too;
      // settings drive it indirectly via the staged turnOptions.
      model: undefined,
      sandbox,
      approvalPolicy,
      resumeThreadId: attemptResume ? resumeFrom : undefined,
      approvalHandler: supervised
        ? (req) => this.handleApprovalRequest(sessionId, threadId, req)
        : undefined,
      jobObject: this.jobObject,
      getSpawnEnv: () => args.env,
    });

    const mapper = new CodexEventMapper(threadId);

    server.on("notification", (notification) => {
      const n = notification as { method?: string; params?: Record<string, unknown> };
      if (n.method === "turn/started") {
        const turn = n.params?.turn as { id?: string } | undefined;
        const flatTurnId =
          typeof n.params?.turnId === "string" ? n.params.turnId : undefined;
        const turnId = turn?.id ?? flatTurnId;
        const entry = this.runtime.get(sessionId);
        if (entry && turnId) entry.pendingTurnId = turnId;
      }
      const events = mapper.mapNotification(notification as CodexNotification);
      traceCodexIngest(threadId, n.method, n.params, events);
      for (const event of events) {
        this.emit("event", event);
      }
    });

    server.on("fatal", (error: string) => {
      logger.error("CodexAppServer fatal", { sessionId, error });
      for (const event of mapper.drainPendingAssistantBoundary(false)) {
        this.emit("event", event);
      }
      this.emit("event", { type: AgentEventType.Error, threadId, error } satisfies AgentEvent);
      this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      void this.runtime.stop(sessionId);
    });

    this.attachFatalDrain(sessionId, server);

    server.on("exit", () => {
      if (!server.isAlive) {
        void this.runtime.stop(sessionId);
      }
    });

    // Propagates start failures to the runtime, which surfaces them to the
    // `acquire` caller in `sendTurn` (emits Error/Ended there).
    await server.start();

    // Register after a successful handshake so a mid-handshake thread/started
    // notification cannot persist a stale SDK thread id when init later fails.
    server.on("threadIdChanged", (newThreadId: string) => {
      mapper.setMainCodexThreadId(newThreadId);
      this.sdkSessionIds.set(sessionId, newThreadId);
      this.emit("event", {
        type: AgentEventType.System,
        threadId,
        subtype: "sdk_session_id:" + newThreadId,
      } satisfies AgentEvent);
    });

    if (server.resumeFailed) {
      logger.warn("Codex session context lost; resume failed, started fresh thread", { sessionId });
      this.emit("event", {
        type: AgentEventType.System,
        threadId,
        subtype: "context_lost",
      } satisfies AgentEvent);
    }

    if (server.threadId) {
      mapper.setMainCodexThreadId(server.threadId);
      this.sdkSessionIds.set(sessionId, server.threadId);
      this.emit("event", {
        type: AgentEventType.System,
        threadId,
        subtype: "sdk_session_id:" + server.threadId,
      } satisfies AgentEvent);
    }

    const state: CodexSessionState = {
      sessionId,
      threadId,
      server,
      mapper,
      lastUsedAt: Date.now(),
      sandboxMode: sandbox,
      runTurnSeq: 0,
      pendingTurnId: null,
    };

    // Run the first turn for the staged payload. `sendTurn` consults
    // `pendingStops` after `acquire` returns; only fire the turn if no stop
    // raced in. The runtime stores the state before this resolves, so
    // `runTurn`'s `this.runtime.get(sessionId)` sees it.
    const staged = this.pendingSpawnTurns.get(sessionId);
    if (staged && !this.pendingStops.has(sessionId)) {
      const { input, turnOptions } = staged;
      this.pendingSpawnTurns.delete(sessionId);
      // SessionRuntime inserts `state` into the pool only after `spawn` resolves.
      // queueMicrotask runs before that continuation, so a pool identity check drops
      // the first turn on every new session (UI: Thinking forever, turn/start never sent).
      setImmediate(() => {
        if (!this.runtime.get(sessionId)) return;
        void this.runTurn(sessionId, threadId, server, input, turnOptions);
      });
    }

    return { state, pids: [] };
  }

  /** Eviction guard: a turn is in flight while `pendingTurnId` is set. */
  isBusy(state: CodexSessionState): boolean {
    return state.pendingTurnId != null;
  }

  /** Graceful protocol interrupt of the in-flight turn (does not kill the process). */
  async interrupt(state: CodexSessionState): Promise<void> {
    for (const event of state.mapper.drainPendingAssistantBoundary(false)) {
      this.emit("event", event);
    }
    await state.server.interruptTurn();
  }

  /**
   * Provider teardown: drain pending permissions for this session as
   * cancelled (so orphaned approval cards clear), then kill the app-server.
   * Drives every teardown path (stop, shutdown, eviction, stale-discard).
   */
  async close(state: CodexSessionState): Promise<void> {
    for (const event of state.mapper.drainPendingAssistantBoundary(false)) {
      this.emit("event", event);
    }
    this.drainPending((e) => e.sessionId === state.sessionId);
    await state.server.kill();
  }

  /** A pooled session must be discarded before reuse if the process died or the sandbox/permission mode changed. */
  isStale(state: CodexSessionState, args: { cwd: string; permissionMode: string }): boolean {
    if (!state.server.isAlive) return true;
    const sandbox = args.permissionMode === "full" ? "danger-full-access" : "workspace-write";
    return state.sandboxMode !== sandbox;
  }

  /**
   * Sends a single turn to the app-server and waits for matching `turn/completed`.
   * Overlapping sends preempt prior waits so stale completions cannot finish
   * the wrong promise. Emits `ended` when the turn finishes for this wait only.
   */
  private async runTurn(
    sessionId: string,
    threadId: string,
    server: CodexAppServer,
    input: string | TurnInputPart[],
    turnOptions?: CodexTurnOptions,
  ): Promise<void> {
    const entry = this.runtime.get(sessionId);
    if (!entry) return;

    for (const event of entry.mapper.drainPendingAssistantBoundary(false)) {
      this.emit("event", event);
    }
    entry.mapper.prepareForTurn();

    // Only pay the turn/interrupt round-trip when a previous turn is actually
    // in flight. Interrupting an idle session added a needless RPC (up to its
    // 5s timeout) of latency to every message.
    const hadInflightTurn =
      entry.pendingTurnId !== null || entry.abortPendingTurnWait !== undefined;

    entry.abortPendingTurnWait?.();
    entry.abortPendingTurnWait = undefined;

    entry.runTurnSeq += 1;
    const seq = entry.runTurnSeq;
    entry.pendingTurnId = null;

    if (hadInflightTurn) {
      await server.interruptTurn();
    }

    let serverDied = false;
    let endedEmitted = false;

    try {
      await new Promise<void>((resolve, reject) => {
        let activityTimer: ReturnType<typeof setTimeout>;
        let settled = false;

        const cleanup = () => {
          if (settled) return;
          settled = true;
          clearTimeout(activityTimer);
          server.removeListener("notification", onNotification);
          server.removeListener("activity", onActivity);
          server.removeListener("fatal", onFatal);
          if (entry.abortPendingTurnWait === abortThis) entry.abortPendingTurnWait = undefined;
        };

        const armTimer = () => {
          clearTimeout(activityTimer);
          activityTimer = setTimeout(() => {
            // Silence while an approval card waits on the user is the user's
            // silence, not the server's: keep the turn alive until they decide.
            if (this.hasPendingApprovalFor(sessionId)) {
              armTimer();
              return;
            }
            // Probe before giving up: a turn is only abandoned when the
            // app-server stops answering RPCs, never just for being slow.
            // A healthy-but-silent turn (long tool, deep reasoning) re-arms
            // and can run indefinitely.
            void server.ping().then((alive) => {
              if (settled) return;
              if (alive) {
                logger.debug("Codex turn silent but server responsive; watchdog re-armed", {
                  sessionId,
                  silenceMs: TURN_TIMEOUT_MS,
                });
                armTimer();
                return;
              }
              cleanup();
              reject(new CodexTurnIdleTimeoutError());
            });
          }, TURN_TIMEOUT_MS);
        };

        // Server-initiated approval requests count as liveness too.
        const onActivity = () => armTimer();

        const abortThis = () => {
          cleanup();
          reject(new CodexTurnSupersededError());
        };
        entry.abortPendingTurnWait = abortThis;

        const onNotification = (notification: unknown) => {
          armTimer();
          const n = notification as { method?: string; params?: Record<string, unknown> };
          if (n.method === "turn/completed") {
            const turn = n.params?.turn as { id?: string } | undefined;
            const tid = turn?.id;
            if (tid && entry.pendingTurnId && tid !== entry.pendingTurnId) {
              logger.debug("Codex turn/completed ignored (stale or unmatched)", {
                tid,
                pending: entry.pendingTurnId,
                seq,
                liveSeq: entry.runTurnSeq,
              });
              return;
            }
            if (seq !== entry.runTurnSeq) return;
            cleanup();
            resolve();
          }
        };

        const onFatal = () => {
          cleanup();
          serverDied = true;
          reject(new Error("Codex app-server died during turn"));
        };

        armTimer();
        server.on("notification", onNotification);
        server.on("activity", onActivity);
        server.once("fatal", onFatal);

        void (async () => {
          try {
            const turnId = await server.sendTurn(input, turnOptions);
            if (turnId && seq === entry.runTurnSeq) entry.pendingTurnId = turnId;
          } catch (err) {
            cleanup();
            reject(err);
          }
        })();
      });
    } catch (e: unknown) {
      if (e instanceof CodexTurnSupersededError) return;
      if (e instanceof CodexTurnIdleTimeoutError) {
        logger.warn("Codex turn idle timeout (suppressed from UI)", {
          sessionId,
          timeoutMs: TURN_TIMEOUT_MS,
        });
        for (const event of entry.mapper.drainPendingAssistantBoundary(false)) {
          this.emit("event", event);
        }
        // Interrupt the upstream turn so the app-server state matches the UI
        // ("ended") instead of silently chewing in the background.
        void server.interruptTurn();
        return;
      }
      if (!serverDied && seq === entry.runTurnSeq) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logger.error("Codex turn failed", { sessionId, error: errorMessage });
        for (const event of entry.mapper.drainPendingAssistantBoundary(false)) {
          this.emit("event", event);
        }
        this.emit("event", { type: AgentEventType.Error, threadId, error: errorMessage } satisfies AgentEvent);
      }
    } finally {
      if (seq === entry.runTurnSeq) {
        // The turn for this seq has settled: clear the in-flight marker so the
        // runtime's busy guard (`isBusy` reads `pendingTurnId`) stops sparing
        // the session from idle eviction. A superseding turn owns its own id.
        entry.pendingTurnId = null;
      }
      if (!serverDied && seq === entry.runTurnSeq && !endedEmitted) {
        endedEmitted = true;
        this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      }
    }
  }

  /**
   * Bridges a codex app-server serverRequest into the Phase 1 permission flow.
   * Allocates a requestId, synthesises a PermissionRequest for the card UI,
   * emits permission_request, and returns a promise that the app-server
   * response listener awaits. Resolved by resolvePermission or by session
   * shutdown/stop (which supply "cancelled").
   */
  private handleApprovalRequest(
    sessionId: string,
    threadId: string,
    request: CodexApprovalRequest,
  ): Promise<unknown> {
    const requestId = randomUUID();
    const synthesized = synthesizeCodexPermissionRequest({
      threadId,
      requestId,
      method: request.method,
      params: request.params,
    });

    return new Promise<unknown>((resolve) => {
      this.pendingPermissions.set(requestId, {
        sessionId,
        threadId,
        toolName: synthesized.toolName,
        input: synthesized.input,
        title: synthesized.title,
        method: request.method,
        params: request.params,
        resolve,
      });
      this.emit("permission_request", synthesized satisfies PermissionRequest);
    });
  }

  /**
   * Resolve a pending permission request. Mirrors ClaudeProvider.resolvePermission.
   * Returns true if requestId was found. On resolve, the codex app-server unblocks.
   */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return false;
    this.pendingPermissions.delete(requestId);

    // Reset idle timer on the owning session so user attention counts as activity.
    this.runtime.recordUsage(entry.sessionId);
    const session = this.runtime.get(entry.sessionId);
    if (session) session.lastUsedAt = Date.now();

    const response = mapDecisionToCodexResponse(entry.method, decision, entry.params);
    entry.resolve(response);
    this.emit("permission_resolved", { requestId, decision });
    return true;
  }

  /** List pending permissions for a given thread. */
  listPendingPermissions(threadId: string): PermissionRequest[] {
    const out: PermissionRequest[] = [];
    for (const [requestId, entry] of this.pendingPermissions) {
      if (entry.threadId !== threadId) continue;
      out.push({
        requestId,
        threadId: entry.threadId,
        toolName: entry.toolName,
        input: entry.input,
        title: entry.title,
      });
    }
    return out;
  }

  /**
   * Install a fatal listener on a CodexAppServer that drains pending permissions
   * for this session when the child process dies unexpectedly. Kept as its own
   * method so tests can invoke it against a stub EventEmitter.
   */
  private attachFatalDrain(sessionId: string, server: { on: (e: string, h: (...args: unknown[]) => void) => void }): void {
    server.on("fatal", () => {
      this.drainPending((e) => e.sessionId === sessionId);
    });
  }

  /** True when at least one permission approval is awaiting the user for this session. */
  private hasPendingApprovalFor(sessionId: string): boolean {
    for (const entry of this.pendingPermissions.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Drain all pending permissions that match a predicate, resolving each as "cancelled".
   * Used by stopSession and shutdown to unblock any in-flight approvals so the
   * codex turn can tear down cleanly.
   */
  private drainPending(predicate: (entry: PendingPermissionEntry) => boolean): void {
    for (const [requestId, entry] of [...this.pendingPermissions]) {
      if (!predicate(entry)) continue;
      this.pendingPermissions.delete(requestId);
      const response = mapDecisionToCodexResponse(entry.method, "cancelled", entry.params);
      entry.resolve(response);
      this.emit("permission_resolved", { requestId, decision: "cancelled" as const });
    }
  }

  /**
   * Kills a running session's subprocess and cancels any pending permissions
   * for its thread. The runtime's `stop` runs `interrupt` → `close` (which
   * drains permissions for the session, see {@link close}) → hard kill. When
   * the session has not spawned yet, record the intent so `sendTurn`/`spawn`
   * tear it down on arrival.
   */
  stopSession(sessionId: string): void {
    const exists = this.runtime.get(sessionId) !== undefined;
    if (exists) {
      void this.runtime.stop(sessionId).catch((err: unknown) => {
        logger.warn("Codex stopSession failed", { sessionId, error: String(err) });
      });
    } else {
      // Drain any pending permissions for a session still mid-spawn so cards
      // clear immediately; close() will not run until/unless the session lands.
      this.drainPending((e) => e.sessionId === sessionId);
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
  discardSession(sessionId: string): void {
    if (this.runtime.get(sessionId) === undefined) return;
    void this.runtime.stop(sessionId).catch((err: unknown) => {
      logger.warn("Codex discardSession failed", { sessionId, error: String(err) });
    });
  }

  /** Tears down all sessions, drains pending permissions, and stops the eviction timer. */
  shutdown(): void {
    // Drain everything up front: `runtime.shutdown` stops each session
    // (close drains per-session), but draining all here also clears any
    // permissions whose session never landed in the pool.
    this.drainPending(() => true);
    void this.runtime.shutdown().catch((err: unknown) => {
      logger.warn("Codex runtime shutdown failed", { error: String(err) });
    });
    this.sdkSessionIds.clear();
    this.pendingSpawnTurns.clear();
    logger.info("CodexProvider shutdown complete");
  }
}
