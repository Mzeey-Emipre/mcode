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
import { promisify } from "util";
import { injectable, inject } from "tsyringe";
import { EventEmitter } from "events";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession } from "@github/copilot-sdk";
import { logger } from "@mcode/shared";
import { SettingsService } from "../../services/settings-service.js";
import type {
  IAgentProvider,
  ProviderId,
  ReasoningLevel,
  AgentEvent,
  AttachmentMeta,
} from "@mcode/contracts";

/** Module-level promisified execFile for CLI availability probing. */
const execFileAsync = promisify(execFile);

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

  private client: CopilotClient | null = null;
  private lastCliPath: string | undefined;
  private sessions = new Map<string, SessionEntry>();
  private sdkSessionIds = new Map<string, string>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
  ) {
    super();
  }

  /**
   * Check whether the Copilot CLI binary is reachable.
   * Returns an error message if unavailable, or null if the CLI is found.
   */
  private async checkCliAvailable(): Promise<string | null> {
    const settings = await this.settingsService.get();
    const cliPath = settings.provider.cli.copilot || "gh";

    try {
      // shell: true is required on Windows to resolve .cmd shims from npm global installs
      await execFileAsync(cliPath, ["--version"], { timeout: 5000, shell: true });
      return null;
    } catch {
      if (!settings.provider.cli.copilot) {
        return "Copilot CLI not found. Install it with: npm install -g @github/copilot\n\nOr set a custom path in Settings > Provider > Copilot CLI path.";
      }
      return `Copilot CLI not found at "${cliPath}". Check the path in Settings > Provider > Copilot CLI path.`;
    }
  }

  /**
   * Rebuild the CopilotClient when the CLI path setting changes.
   * Only recreates the client if the path actually differs from the last known path.
   */
  private async refreshClient(): Promise<void> {
    const settings = await this.settingsService.get();
    const cliPath = settings.provider.cli.copilot || undefined;
    if (cliPath === this.lastCliPath && this.client !== null) return;

    if (this.client) {
      await this.client.stop().catch((err) =>
        logger.warn("CopilotProvider: error stopping old client", { error: String(err) }),
      );
    }

    this.lastCliPath = cliPath;
    this.client = new CopilotClient(cliPath ? { cliPath } : undefined);
  }

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
      logger.error("CopilotProvider sendMessage error", {
        sessionId: params.sessionId,
        error: String(e),
      });
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

    // Strip "mcode-" prefix to derive the threadId used in emitted AgentEvents
    const threadId = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;

    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      // Abort in-flight turn by sending a new message on the existing session.
      // The previous runTurn promise will resolve when session.idle fires.
      void this.runTurn(sessionId, threadId, existing.session, message);
      return;
    }

    // Probe CLI availability only when starting a new session
    const cliError = await this.checkCliAvailable();
    if (cliError) {
      this.emit("event", {
        type: "error",
        threadId,
        error: cliError,
      } satisfies AgentEvent);
      this.emit("event", {
        type: "ended",
        threadId,
      } satisfies AgentEvent);
      return;
    }

    const client = this.client!;
    const sdkSessionId = this.sdkSessionIds.get(sessionId);

    let session: CopilotSession;

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
              toolInput: (toolArgs as Record<string, unknown>) ?? {},
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

        // assistant.usage — token counts after a model call
        unsubscribers.push(
          session.on("assistant.usage", (event) => {
            const { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0 } = event.data;
            const tokensIn = inputTokens + cacheReadTokens;
            this.emit("event", {
              type: "turnComplete",
              threadId,
              reason: "end_turn",
              costUsd: null,
              tokensIn,
              tokensOut: outputTokens,
              contextWindow: undefined,
              totalProcessedTokens: tokensIn + outputTokens,
            } satisfies AgentEvent);
          }),
        );

        // session.error — provider-level error
        unsubscribers.push(
          session.on("session.error", (event) => {
            this.emit("event", {
              type: "error",
              threadId,
              error: event.data.message,
            } satisfies AgentEvent);
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
      }
    }
  }

  /** Pre-load an SDK session ID mapping (e.g. from the database on startup). */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    this.sdkSessionIds.set(sessionId, sdkSessionId);
  }

  /** Disconnect and remove an active session. */
  stopSession(sessionId: string): void {
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
