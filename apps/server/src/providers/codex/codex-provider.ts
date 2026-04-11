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
import { logger } from "@mcode/shared";
import { SettingsService } from "../../services/settings-service.js";
import type {
  IAgentProvider,
  ProviderId,
  ReasoningLevel,
  AgentEvent,
  AttachmentMeta,
} from "@mcode/contracts";
import { AgentEventType } from "@mcode/contracts";
import { checkCodexVersion, meetsMinVersion } from "./codex-version.js";
import { CodexAppServer } from "./codex-app-server.js";
import { CodexEventMapper } from "./codex-event-mapper.js";
import type { TurnInputPart, CodexNotification } from "./codex-types.js";

/** Idle TTL before a session is evicted (10 minutes). */
const IDLE_TTL_MS = 10 * 60 * 1000;
/** How often to check for idle sessions (1 minute). */
const EVICTION_INTERVAL_MS = 60 * 1000;
/** Maximum time to wait for a turn to complete before timing out (10 minutes). */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

interface SessionEntry {
  server: CodexAppServer;
  mapper: CodexEventMapper;
  lastUsedAt: number;
  /** Sandbox mode used when this session was started; used to detect permission mode changes. */
  sandboxMode: string;
}

/**
 * Builds the Codex turn input from a message string and optional attachments.
 * Images become `local_image` parts; non-image files become sanitised text notes
 * that omit internal filesystem paths to prevent prompt injection.
 */
function buildCodexInput(
  message: string,
  attachments?: AttachmentMeta[],
): TurnInputPart[] {
  const inputs: TurnInputPart[] = [];

  for (const att of attachments ?? []) {
    if (att.mimeType.startsWith("image/")) {
      inputs.push({ type: "local_image", path: att.sourcePath });
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
function toCodexEffort(level?: ReasoningLevel): string | undefined {
  if (!level) return undefined;
  // "max" is Claude-specific; map to "high" for codex.
  if (level === "max") return "high";
  // "low", "medium", "high", "xhigh" are all valid codex effort levels.
  return level;
}

/** Codex provider adapter implementing IAgentProvider with a persistent app-server process per session. */
@injectable()
export class CodexProvider extends EventEmitter implements IAgentProvider {
  readonly id: ProviderId = "codex";
  /** Codex CLI is an agentic tool with no one-shot text completion mode. */
  readonly supportsCompletion = false;

  private sessions = new Map<string, SessionEntry>();
  private sdkSessionIds = new Map<string, string>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
  ) {
    super();
  }

  /**
   * Starts or continues a session by sending a message to the Codex app-server.
   * For new sessions, spawns a subprocess and runs the JSON-RPC handshake first.
   * The method returns immediately; events stream via the `event` EventEmitter channel.
   */
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
    const settings = await this.settingsService.get();
    const cliPath = settings.provider.cli.codex || "codex";

    const {
      sessionId, message, cwd, model, resume, permissionMode,
      reasoningLevel, attachments,
    } = params;

    const input = buildCodexInput(message, attachments);
    const threadId = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;

    if (!this.evictionTimer) {
      this.evictionTimer = setInterval(
        () => this.evictIdleSessions(),
        EVICTION_INTERVAL_MS,
      );
    }

    const sandbox = permissionMode === "full" ? "danger-full-access" : "workspace-write";
    const approvalPolicy = permissionMode === "full" ? "never" : "on-request";
    const existing = this.sessions.get(sessionId);

    const turnOptions = {
      model: model || undefined,
      effort: toCodexEffort(reasoningLevel),
    };

    if (existing) {
      if (existing.sandboxMode === sandbox) {
        // Same permission mode - reuse the running session
        existing.lastUsedAt = Date.now();
        existing.mapper.reset();
        void this.runTurn(sessionId, threadId, existing.server, input, turnOptions);
        return;
      }
      // Permission mode changed - kill the old session so we can start fresh with the correct sandbox
      logger.info("Codex session restarted due to permission mode change", {
        sessionId,
        from: existing.sandboxMode,
        to: sandbox,
      });
      this.sessions.delete(sessionId);
      // Clear the stored SDK thread ID so the new session starts fresh rather than
      // resuming the old thread (which would inherit the old sandbox mode).
      this.sdkSessionIds.delete(sessionId);
      existing.server.kill().catch((err: unknown) => {
        logger.warn("Codex session kill on permission change failed", { error: String(err) });
      });
    }

    // Version check only when starting a new session
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

    const resumeId = this.sdkSessionIds.get(sessionId);
    const attemptResume = !!(resume && resumeId);

    const server = new CodexAppServer({
      cliPath,
      workingDirectory: cwd,
      model: model || undefined,
      sandbox,
      approvalPolicy,
      resumeThreadId: attemptResume ? resumeId : undefined,
    });

    const mapper = new CodexEventMapper(threadId);

    server.on("notification", (notification) => {
      const events = mapper.mapNotification(notification as CodexNotification);
      for (const event of events) {
        this.emit("event", event);
      }
    });

    // When the codex thread ID rotates mid-session (context compaction, etc.),
    // update the in-memory map and persist the new ID so future app restarts
    // resume the correct thread instead of a stale one.
    server.on("threadIdChanged", (newThreadId: string) => {
      this.sdkSessionIds.set(sessionId, newThreadId);
      this.emit("event", {
        type: AgentEventType.System,
        threadId,
        subtype: "sdk_session_id:" + newThreadId,
      } satisfies AgentEvent);
    });

    server.on("fatal", (error: string) => {
      logger.error("CodexAppServer fatal", { sessionId, error });
      this.emit("event", { type: AgentEventType.Error, threadId, error } satisfies AgentEvent);
      this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      this.sessions.delete(sessionId);
    });

    server.on("exit", () => {
      if (!server.isAlive) {
        this.sessions.delete(sessionId);
      }
    });

    try {
      await server.start();
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      logger.error("CodexAppServer start failed", { sessionId, error: errorMessage });
      this.emit("event", { type: AgentEventType.Error, threadId, error: errorMessage } satisfies AgentEvent);
      this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      return;
    }

    if (server.resumeFailed) {
      logger.warn("Codex session context lost; resume failed, started fresh thread", { sessionId });
      this.emit("event", {
        type: AgentEventType.System,
        threadId,
        subtype: "context_lost",
      } satisfies AgentEvent);
    }

    if (server.threadId) {
      this.sdkSessionIds.set(sessionId, server.threadId);
      this.emit("event", {
        type: AgentEventType.System,
        threadId,
        subtype: "sdk_session_id:" + server.threadId,
      } satisfies AgentEvent);
    }

    this.sessions.set(sessionId, { server, mapper, lastUsedAt: Date.now(), sandboxMode: sandbox });
    void this.runTurn(sessionId, threadId, server, input, turnOptions);
  }

  /**
   * Sends a single turn to the app-server and waits for `turn/completed`
   * to arrive as a notification.
   * Emits `ended` when the turn finishes, or skips it if the server died
   * (the `fatal` handler already emitted `ended` in that case).
   */
  private async runTurn(
    sessionId: string,
    threadId: string,
    server: CodexAppServer,
    input: string | TurnInputPart[],
    turnOptions?: { model?: string; effort?: string },
  ): Promise<void> {
    let serverDied = false;
    let endedEmitted = false;

    try {
      // Register all listeners BEFORE sendTurn so a turn/completed notification
      // that arrives during the async sendTurn await is never missed.
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(turnTimer);
          server.removeListener("notification", onNotification);
          server.removeListener("fatal", onFatal);
        };
        const onNotification = (notification: unknown) => {
          const n = notification as { method?: string };
          if (n.method === "turn/completed") {
            cleanup();
            resolve();
          }
        };
        const onFatal = () => {
          cleanup();
          serverDied = true;
          reject(new Error("Codex app-server died during turn"));
        };
        const turnTimer = setTimeout(() => {
          cleanup();
          reject(new Error(`Codex turn timed out after ${TURN_TIMEOUT_MS / 1000}s`));
        }, TURN_TIMEOUT_MS);

        server.on("notification", onNotification);
        server.once("fatal", onFatal);

        // Send the turn after listeners are wired.
        server.sendTurn(input, turnOptions).catch((err) => {
          cleanup();
          reject(err);
        });
      });
    } catch (e: unknown) {
      if (!serverDied) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logger.error("Codex turn failed", { sessionId, error: errorMessage });
        this.emit("event", { type: AgentEventType.Error, threadId, error: errorMessage } satisfies AgentEvent);
      }
    } finally {
      // Suppress ended if the fatal handler already emitted it
      if (!serverDied && !endedEmitted) {
        endedEmitted = true;
        this.emit("event", { type: AgentEventType.Ended, threadId } satisfies AgentEvent);
      }
    }
  }

  /** Evicts sessions that have been idle longer than IDLE_TTL_MS. */
  private evictIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastUsedAt > IDLE_TTL_MS) {
        logger.info("Evicted idle Codex session", { sessionId });
        void entry.server.kill();
        this.sessions.delete(sessionId);
      }
    }
  }

  /** Pre-loads an SDK session ID mapping (e.g. from the database on startup). */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    this.sdkSessionIds.set(sessionId, sdkSessionId);
  }

  /** Kills a running session's subprocess immediately. */
  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      void entry.server.kill();
      this.sessions.delete(sessionId);
    }
  }

  /** Tears down all sessions, clears state, and stops the eviction timer. */
  shutdown(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    for (const [, entry] of this.sessions) {
      void entry.server.kill();
    }
    this.sessions.clear();
    this.sdkSessionIds.clear();
    logger.info("CodexProvider shutdown complete");
  }
}
