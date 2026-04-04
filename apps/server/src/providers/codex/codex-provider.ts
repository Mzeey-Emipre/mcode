/**
 * Codex Agent SDK provider adapter.
 * Implements IAgentProvider using @openai/codex-sdk with streaming event mapping.
 *
 * SDK event model:
 *   thread.started -> turn.started -> item.started/updated/completed -> turn.completed
 * Item types: agent_message, command_execution, file_change, mcp_tool_call, reasoning,
 *   web_search, todo_list, error
 */

import { injectable } from "tsyringe";
import { EventEmitter } from "events";
import { Codex } from "@openai/codex-sdk";
import type { Thread as CodexThread } from "@openai/codex-sdk";
import { logger } from "@mcode/shared";
import type {
  IAgentProvider,
  ProviderId,
  ReasoningLevel,
  AgentEvent,
  AttachmentMeta,
} from "@mcode/contracts";

/** Idle TTL before a session is evicted (10 minutes). */
const IDLE_TTL_MS = 10 * 60 * 1000;
/** How often to check for idle sessions (1 minute). */
const EVICTION_INTERVAL_MS = 60 * 1000;

interface SessionEntry {
  thread: CodexThread;
  abortController: AbortController;
  lastUsedAt: number;
}

/** Codex Agent SDK adapter implementing IAgentProvider with streaming events. */
@injectable()
export class CodexProvider extends EventEmitter implements IAgentProvider {
  readonly id: ProviderId = "codex";

  private codex = new Codex();
  private sessions = new Map<string, SessionEntry>();
  private sdkSessionIds = new Map<string, string>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  /** Start or continue a session by sending a message via the Codex SDK. */
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
      logger.error("CodexProvider sendMessage error", {
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
    const { sessionId, message, cwd, model, resume, permissionMode } = params;

    if (!this.evictionTimer) {
      this.evictionTimer = setInterval(
        () => this.evictIdleSessions(),
        EVICTION_INTERVAL_MS,
      );
    }

    const threadId = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;

    const existing = this.sessions.get(sessionId);

    if (existing) {
      existing.lastUsedAt = Date.now();
      // Replace abort controller for the new turn
      existing.abortController = new AbortController();
      await this.runTurn(sessionId, threadId, existing.thread, message, existing.abortController.signal);
      return;
    }

    // Map mcode permission mode to Codex sandbox mode
    const sandboxMode = permissionMode === "full"
      ? "danger-full-access" as const
      : "workspace-write" as const;

    const threadOptions = {
      workingDirectory: cwd,
      model: model || undefined,
      sandboxMode,
    };

    let codexThread: CodexThread;
    const resumeId = this.sdkSessionIds.get(sessionId);

    if (resume && resumeId) {
      try {
        codexThread = this.codex.resumeThread(resumeId, threadOptions);
        logger.info("Resumed Codex thread", { sessionId, resumeId });
      } catch (err) {
        logger.warn("Codex resume failed, starting fresh thread", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.sdkSessionIds.delete(sessionId);
        codexThread = this.codex.startThread(threadOptions);
      }
    } else {
      codexThread = this.codex.startThread(threadOptions);
    }

    const abortController = new AbortController();
    const entry: SessionEntry = {
      thread: codexThread,
      abortController,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(sessionId, entry);

    await this.runTurn(sessionId, threadId, codexThread, message, abortController.signal);
  }

  /** Execute a single turn with streaming, mapping Codex events to AgentEvents. */
  private async runTurn(
    sessionId: string,
    threadId: string,
    codexThread: CodexThread,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    let lastAssistantText = "";

    try {
      const { events } = await codexThread.runStreamed(prompt, { signal });

      for await (const event of events) {
        const entry = this.sessions.get(sessionId);
        if (entry) entry.lastUsedAt = Date.now();

        switch (event.type) {
          case "thread.started": {
            // Capture the SDK thread ID for resume
            const sdkThreadId = codexThread.id;
            if (sdkThreadId && !this.sdkSessionIds.has(sessionId)) {
              this.sdkSessionIds.set(sessionId, sdkThreadId);
              logger.info("Captured Codex thread ID", { sessionId, sdkThreadId });
              this.emit("event", {
                type: "system",
                threadId,
                subtype: "sdk_session_id:" + sdkThreadId,
              } satisfies AgentEvent);
            }
            break;
          }

          case "item.completed": {
            const item = event.item;
            const itemType = item.type;

            if (itemType === "agent_message") {
              const text = (item as { text?: string }).text ?? "";
              if (text) {
                lastAssistantText = text;
              }
            } else if (itemType === "command_execution") {
              const cmd = item as {
                id: string;
                command?: string;
                aggregated_output?: string;
                exit_code?: number;
              };
              const toolCallId = cmd.id;

              this.emit("event", {
                type: "toolUse",
                threadId,
                toolCallId,
                toolName: "command_execution",
                toolInput: { command: cmd.command ?? "" },
              } satisfies AgentEvent);

              this.emit("event", {
                type: "toolResult",
                threadId,
                toolCallId,
                output: cmd.aggregated_output ?? "",
                isError: cmd.exit_code != null && cmd.exit_code !== 0,
              } satisfies AgentEvent);
            } else if (itemType === "file_change") {
              const fc = item as {
                id: string;
                changes?: Array<{ path?: string; kind?: string }>;
              };
              const toolCallId = fc.id;
              const paths = (fc.changes ?? []).map((c) => c.path ?? "").join(", ");

              this.emit("event", {
                type: "toolUse",
                threadId,
                toolCallId,
                toolName: "file_change",
                toolInput: { files: paths },
              } satisfies AgentEvent);

              this.emit("event", {
                type: "toolResult",
                threadId,
                toolCallId,
                output: paths,
                isError: false,
              } satisfies AgentEvent);
            } else if (itemType === "mcp_tool_call") {
              const mcp = item as {
                id: string;
                server?: string;
                tool?: string;
                arguments?: Record<string, unknown>;
                result?: string;
                error?: string;
              };
              const toolCallId = mcp.id;

              this.emit("event", {
                type: "toolUse",
                threadId,
                toolCallId,
                toolName: `mcp:${mcp.server ?? "unknown"}/${mcp.tool ?? "unknown"}`,
                toolInput: mcp.arguments ?? {},
              } satisfies AgentEvent);

              this.emit("event", {
                type: "toolResult",
                threadId,
                toolCallId,
                output: mcp.error ?? mcp.result ?? "",
                isError: !!mcp.error,
              } satisfies AgentEvent);
            }
            // reasoning, web_search, todo_list items are silently consumed
            break;
          }

          case "item.started":
          case "item.updated": {
            // Emit text deltas for incremental agent_message content
            const updatedItem = event.item;
            if (updatedItem.type === "agent_message") {
              const text = (updatedItem as { text?: string }).text ?? "";
              if (text && text !== lastAssistantText) {
                const delta = text.slice(lastAssistantText.length);
                if (delta) {
                  lastAssistantText = text;
                  this.emit("event", {
                    type: "textDelta",
                    threadId,
                    delta,
                  } satisfies AgentEvent);
                }
              }
            }
            break;
          }

          case "turn.completed": {
            // Emit the full message
            if (lastAssistantText) {
              this.emit("event", {
                type: "message",
                threadId,
                content: lastAssistantText,
                tokens: null,
              } satisfies AgentEvent);
            }

            const usage = event.usage as {
              input_tokens?: number;
              cached_input_tokens?: number;
              output_tokens?: number;
            } | undefined;

            const totalInputTokens =
              (usage?.input_tokens ?? 0) +
              (usage?.cached_input_tokens ?? 0);

            this.emit("event", {
              type: "turnComplete",
              threadId,
              reason: "end_turn",
              costUsd: null,
              tokensIn: totalInputTokens,
              tokensOut: usage?.output_tokens ?? 0,
            } satisfies AgentEvent);

            lastAssistantText = "";
            break;
          }

          case "turn.failed": {
            const err = event.error as { message?: string } | undefined;
            const errorMsg = err?.message ?? "Codex turn failed";
            this.emit("event", {
              type: "error",
              threadId,
              error: errorMsg,
            } satisfies AgentEvent);
            break;
          }

          case "error": {
            const msg = (event as { message?: string }).message ?? "Codex stream error";
            this.emit("event", {
              type: "error",
              threadId,
              error: msg,
            } satisfies AgentEvent);
            break;
          }
        }
      }
    } catch (e: unknown) {
      if ((e as { name?: string }).name === "AbortError") {
        logger.info("Codex turn aborted", { sessionId });
      } else {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logger.error("Codex stream error", { sessionId, error: errorMessage });
        this.emit("event", {
          type: "error",
          threadId,
          error: errorMessage,
        } satisfies AgentEvent);
      }
    } finally {
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
        logger.info("Evicting idle Codex session", { sessionId });
        entry.abortController.abort();
        this.sessions.delete(sessionId);
      }
    }
  }

  /** Pre-load an SDK session ID mapping (e.g. from the database on startup). */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    this.sdkSessionIds.set(sessionId, sdkSessionId);
  }

  /** Abort a running session via AbortSignal. */
  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.abortController.abort();
      this.sessions.delete(sessionId);
    }
  }

  /** Tear down all sessions and release resources. */
  shutdown(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    for (const [, entry] of this.sessions) {
      entry.abortController.abort();
    }
    this.sessions.clear();
    this.sdkSessionIds.clear();
    logger.info("CodexProvider shutdown complete");
  }
}
