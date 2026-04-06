/**
 * Claude Agent SDK provider adapter.
 * Implements IAgentProvider using the v1 query() API with a prompt queue pattern.
 * Migrated from apps/desktop/src/main/sidecar/client.ts.
 */

import { injectable } from "tsyringe";
import { EventEmitter } from "events";
import { readFile } from "fs/promises";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "@mcode/shared";
import type {
  IAgentProvider,
  ProviderId,
  ReasoningLevel,
  AgentEvent,
  AttachmentMeta,
} from "@mcode/contracts";
import { buildReasoningOptions } from "./build-reasoning-options.js";

/** Idle TTL before a session is evicted (10 minutes). */
const IDLE_TTL_MS = 10 * 60 * 1000;
/** How often to check for idle sessions (1 minute). */
const EVICTION_INTERVAL_MS = 60 * 1000;
/** Max queued messages before push() warns and drops. */
const MAX_QUEUE_DEPTH = 20;

interface SessionEntry {
  query: Query;
  pushMessage: (msg: SDKUserMessage) => void;
  closeQueue: () => void;
  model: string;
  lastUsedAt: number;
  /** When true, the finally block in startStreamLoop should not emit an "ended" event. */
  suppressEnded?: boolean;
}

/**
 * Create an async iterable prompt queue backed by a simple push/pull bridge.
 * Messages pushed via `push()` are yielded by the iterable. Calling `close()`
 * terminates the iterator, signaling the SDK to shut down the subprocess.
 */
function createPromptQueue(): {
  push: (msg: SDKUserMessage) => void;
  close: () => void;
  iterable: AsyncIterable<SDKUserMessage>;
} {
  const pending: SDKUserMessage[] = [];
  let waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null =
    null;
  let done = false;

  const push = (msg: SDKUserMessage): void => {
    if (done) return;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: msg, done: false });
    } else {
      if (pending.length >= MAX_QUEUE_DEPTH) {
        throw new Error(
          `Prompt queue full (depth=${pending.length}), cannot enqueue message`,
        );
      }
      pending.push(msg);
    }
  };

  const close = (): void => {
    done = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({
        value: undefined as unknown as SDKUserMessage,
        done: true,
      });
    }
  };

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (pending.length > 0) {
            return Promise.resolve({
              value: pending.shift()!,
              done: false,
            });
          }
          if (done) {
            return Promise.resolve({
              value: undefined as unknown as SDKUserMessage,
              done: true,
            });
          }
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
      };
    },
  };

  return { push, close, iterable };
}

/** Convert a plain string message into an SDKUserMessage. */
function toUserMessage(text: string, sessionId: string): SDKUserMessage {
  return {
    type: "user" as const,
    message: {
      role: "user" as const,
      content: text,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

/**
 * Checks whether the SDK used a different model than the one requested.
 * Returns the actual model ID if a fallback fired, or null if the requested
 * model ran as expected.
 *
 * @param modelUsage - `SDKResultSuccess.modelUsage` record (keys are model IDs)
 * @param requestedModel - the model ID that was passed to the SDK
 */
export function detectFallbackModel(
  modelUsage: Record<string, unknown>,
  requestedModel: string,
): string | null {
  const usedModels = Object.keys(modelUsage);
  // SDK resolves aliases to dated IDs (e.g. "claude-sonnet-4-6" → "claude-sonnet-4-6-20250514").
  // A dated variant that starts with the requested alias is the same model, not a fallback.
  const requestedModelRan = usedModels.some(
    (m) => m === requestedModel || m.startsWith(requestedModel),
  );
  // Only report a fallback when the requested model is completely absent from usage.
  // The SDK may report multiple models (e.g. primary + tool-routing model) in a single
  // turn; that is NOT a fallback as long as the requested model was used.
  if (requestedModelRan) return null;

  return usedModels[0] ?? null;
}

/** Claude Agent SDK adapter implementing IAgentProvider with prompt queue pattern. */
@injectable()
export class ClaudeProvider extends EventEmitter implements IAgentProvider {
  readonly id: ProviderId = "claude";

  private sessions = new Map<string, SessionEntry>();
  private sdkSessionIds = new Map<string, string>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  /** Start or continue a session by sending a message via the SDK. */
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
      logger.error("sendMessage error", {
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
    const {
      sessionId,
      message,
      cwd,
      model,
      fallbackModel,
      resume,
      permissionMode,
      attachments,
      reasoningLevel,
    } = params;

    if (!this.evictionTimer) {
      this.evictionTimer = setInterval(
        () => this.evictIdleSessions(),
        EVICTION_INTERVAL_MS,
      );
    }

    const existing = this.sessions.get(sessionId);
    const isBypass = permissionMode === "full";
    const sdkPermissionMode = isBypass
      ? ("bypassPermissions" as const)
      : ("default" as const);
    const uuid = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;
    const resolvedCwd = cwd || process.cwd();
    const resolvedModel = model || "claude-sonnet-4-6";

    if (isBypass) {
      logger.warn("Using bypassPermissions for session", { sessionId });
    }

    const prompt =
      attachments && attachments.length > 0
        ? await this.buildMultimodalMessage(message, attachments, sessionId)
        : toUserMessage(message, sessionId);

    if (existing) {
      existing.lastUsedAt = Date.now();

      if (existing.model !== resolvedModel) {
        logger.info("Model changed, calling setModel()", {
          sessionId,
          model: resolvedModel,
        });
        try {
          await existing.query.setModel(resolvedModel);
          existing.model = resolvedModel;
        } catch (err) {
          logger.error(
            "setModel() failed, closing session for recreation",
            {
              sessionId,
              error:
                err instanceof Error ? err.message : String(err),
            },
          );
          existing.suppressEnded = true;
          existing.closeQueue();
          existing.query.close();
          this.sessions.delete(sessionId);
          return this.doSendMessage({ ...params, resume: false });
        }
      }

      existing.pushMessage(prompt);
      return;
    }

    const resumeId = this.sdkSessionIds.get(sessionId) ?? uuid;

    const baseOptions = {
      cwd: resolvedCwd,
      model: resolvedModel,
      settingSources: [
        "user" as const,
        "project" as const,
        "local" as const,
      ],
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
      },
      tools: {
        type: "preset" as const,
        preset: "claude_code" as const,
      },
      permissionMode: sdkPermissionMode,
      ...(isBypass && { allowDangerouslySkipPermissions: true }),
      ...buildReasoningOptions(reasoningLevel, resolvedModel),
      ...(fallbackModel && { fallbackModel }),
      includePartialMessages: true,
    };
    const options = resume
      ? { ...baseOptions, resume: resumeId }
      : { ...baseOptions, sessionId: uuid };

    const queue = createPromptQueue();

    logger.info("Starting query()", {
      sessionId,
      resume,
      resumeId,
      model: resolvedModel,
      cwd: resolvedCwd,
    });

    const q = sdkQuery({ prompt: queue.iterable, options });

    const entry: SessionEntry = {
      query: q,
      pushMessage: queue.push,
      closeQueue: queue.close,
      model: resolvedModel,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(sessionId, entry);

    if (resume) {
      const failedEvent = `_resumeFailed:${sessionId}`;
      const doneEvent = `_streamDone:${sessionId}`;

      let resumeHandler: (() => void) | null = null;
      let doneHandler: (() => void) | null = null;

      const retryPromise = new Promise<boolean>((resolve) => {
        resumeHandler = () => resolve(true);
        doneHandler = () => resolve(false);
        this.once(failedEvent, resumeHandler);
        this.once(doneEvent, doneHandler);
      });

      this.startStreamLoop(sessionId, q);
      queue.push(prompt);

      let needsRetry: boolean;
      try {
        needsRetry = await retryPromise;
      } finally {
        // Guarantee both listeners are removed regardless of how the
        // promise settled (resolve, reject, or upstream cancellation).
        if (resumeHandler) this.removeListener(failedEvent, resumeHandler);
        if (doneHandler) this.removeListener(doneEvent, doneHandler);
      }

      if (needsRetry) {
        logger.info("Resume failed, falling back to fresh query()", {
          sessionId,
        });
        this.sdkSessionIds.delete(sessionId);

        const freshQueue = createPromptQueue();
        const freshOptions = { ...baseOptions, sessionId: uuid };

        const freshQ = sdkQuery({
          prompt: freshQueue.iterable,
          options: freshOptions,
        });
        const freshEntry: SessionEntry = {
          query: freshQ,
          pushMessage: freshQueue.push,
          closeQueue: freshQueue.close,
          model: resolvedModel,
          lastUsedAt: Date.now(),
        };
        this.sessions.set(sessionId, freshEntry);
        this.startStreamLoop(sessionId, freshQ);
        freshQueue.push(prompt);
      }
    } else {
      this.startStreamLoop(sessionId, q);
      queue.push(prompt);
    }
  }

  /** Run the stream loop for a query, mapping SDK events to AgentEvent types. */
  private startStreamLoop(sessionId: string, q: Query): void {
    const threadId = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;

    (async () => {
      let suppressEnded = false;
      try {
        let lastAssistantText = "";
        let sessionInitialized = false;
        /** Tracks whether the SDK has signalled compaction is active for this stream. */
        let sessionCompacting = false;
        /** Tracks the last known context window size for post-compaction estimation. */
        let lastContextWindow: number | undefined = undefined;

        for await (const msg of q) {
          const entry = this.sessions.get(sessionId);
          if (entry) entry.lastUsedAt = Date.now();

          const anyMsg = msg as Record<string, unknown>;

          if (!sessionInitialized && anyMsg.type !== "result") {
            sessionInitialized = true;
          }

          // Capture SDK session ID
          const sdkSid = anyMsg.session_id as string | undefined;
          if (
            sdkSid &&
            sessionInitialized &&
            !this.sdkSessionIds.has(sessionId)
          ) {
            this.sdkSessionIds.set(sessionId, sdkSid);
            logger.info("Captured SDK session ID", {
              sessionId,
              sdkSessionId: sdkSid,
            });
            this.emit("event", {
              type: "system",
              threadId,
              subtype: "sdk_session_id:" + sdkSid,
            } satisfies AgentEvent);
          }

          // Detect failed resume
          if (
            anyMsg.type === "result" &&
            anyMsg.is_error === true &&
            !sessionInitialized
          ) {
            const errors = anyMsg.errors as string[] | undefined;
            const isNoConversation = errors?.some(
              (e) =>
                typeof e === "string" &&
                e.includes("No conversation found"),
            );
            if (isNoConversation) {
              logger.warn(
                "Resume failed: conversation not found, will retry with fresh query()",
                { sessionId },
              );
              this.sdkSessionIds.delete(sessionId);
              this.emit("event", {
                type: "system",
                threadId,
                subtype: "session_restarted",
              } satisfies AgentEvent);
              this.emit(`_resumeFailed:${sessionId}`);
              suppressEnded = true;
              return;
            }
          }

          switch (anyMsg.type) {
            case "assistant": {
              const contentBlocks =
                (
                  anyMsg.message as {
                    content?: Array<Record<string, unknown>>;
                  }
                )?.content ?? [];
              const text = contentBlocks
                .filter((b) => b.type === "text")
                .map((b) => (b.text as string) ?? "")
                .join("");

              if (text && text !== lastAssistantText) {
                lastAssistantText = text;
              }

              for (const block of contentBlocks) {
                if (block.type === "tool_use") {
                  this.emit("event", {
                    type: "toolUse",
                    threadId,
                    toolCallId:
                      (block.id as string) || "",
                    toolName:
                      (block.name as string) || "unknown",
                    toolInput:
                      (block.input as Record<
                        string,
                        unknown
                      >) || {},
                  } satisfies AgentEvent);
                }
              }
              break;
            }

            case "result": {
              if (lastAssistantText) {
                this.emit("event", {
                  type: "message",
                  threadId,
                  content: lastAssistantText,
                  tokens:
                    (
                      anyMsg.usage as {
                        output_tokens?: number;
                      }
                    )?.output_tokens ?? null,
                } satisfies AgentEvent);
              }

              // Detect if the SDK used a fallback model. Guard on entry?.model
              // to avoid a spurious event if the session was evicted mid-stream.
              const requestedModel = entry?.model;
              if (requestedModel) {
                const usedFallback = detectFallbackModel(
                  (anyMsg.modelUsage as Record<string, unknown>) ?? {},
                  requestedModel,
                );
                if (usedFallback) {
                  this.emit("event", {
                    type: "modelFallback",
                    threadId,
                    requestedModel,
                    actualModel: usedFallback,
                  } satisfies AgentEvent);
                }
              }

              // Extract the authoritative context window from SDK modelUsage.
              // modelUsage is Record<modelId, { contextWindow?: number, ... }>.
              const sdkModelUsage = (anyMsg.modelUsage ?? {}) as Record<
                string,
                { contextWindow?: number }
              >;
              const sdkContextWindow = Object.values(sdkModelUsage).find(
                (u) => typeof u.contextWindow === "number",
              )?.contextWindow;

              // With prompt caching, input_tokens is only the uncached portion.
              // Sum all input token categories for the true context window fill.
              const usage = (anyMsg.usage ?? {}) as {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
              // Output tokens become input context on the next turn, so include
              // them so the tracker reflects the true next-turn fill.
              const totalInputTokens =
                (usage.input_tokens ?? 0) +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0) +
                (usage.output_tokens ?? 0);

              this.emit("event", {
                type: "turnComplete",
                threadId,
                reason:
                  (anyMsg.stop_reason as string) ||
                  (anyMsg.subtype as string) ||
                  "end_turn",
                costUsd:
                  (anyMsg.total_cost_usd as number) ?? null,
                tokensIn: totalInputTokens,
                tokensOut: usage.output_tokens ?? 0,
                contextWindow: sdkContextWindow,
              } satisfies AgentEvent);

              lastContextWindow = sdkContextWindow;

              lastAssistantText = "";
              break;
            }

            case "system": {
              // subtype 'status' carries the SDK's compaction state.
              // Only emit a compacting event on known transitions to avoid
              // spurious "active: false" from unrelated status strings (e.g.
              // "idle", "ready") that the SDK may send during session lifecycle.
              if ((anyMsg.subtype as string) === "status") {
                const sdkStatus = (anyMsg as { status?: string | null }).status;
                if (sdkStatus === "compacting" && !sessionCompacting) {
                  sessionCompacting = true;
                  this.emit("event", {
                    type: "compacting",
                    threadId,
                    active: true,
                  } satisfies AgentEvent);
                } else if (sdkStatus !== "compacting" && sessionCompacting) {
                  sessionCompacting = false;
                  this.emit("event", {
                    type: "compacting",
                    threadId,
                    active: false,
                  } satisfies AgentEvent);
                  // Emit a rough post-compaction estimate so the tracker
                  // reappears immediately. The SDK typically compacts to ~50%
                  // of the context window. This is overwritten by the next
                  // authoritative turnComplete.
                  const ctxWindow = lastContextWindow ?? 200_000;
                  if (ctxWindow > 0) {
                    this.emit("event", {
                      type: "contextEstimate",
                      threadId,
                      tokensIn: Math.round(ctxWindow * 0.5),
                      contextWindow: ctxWindow,
                    } satisfies AgentEvent);
                  }
                }
              } else {
                this.emit("event", {
                  type: "system",
                  threadId,
                  subtype: (anyMsg.subtype as string) || "unknown",
                } satisfies AgentEvent);
              }
              break;
            }

            case "tool_use": {
              this.emit("event", {
                type: "toolUse",
                threadId,
                toolCallId: (anyMsg.id as string) || "",
                toolName:
                  (anyMsg.tool_name as string) ||
                  (anyMsg.name as string) ||
                  "unknown",
                toolInput:
                  (anyMsg.tool_input as Record<
                    string,
                    unknown
                  >) ||
                  (anyMsg.input as Record<
                    string,
                    unknown
                  >) ||
                  {},
              } satisfies AgentEvent);
              break;
            }

            case "tool_result": {
              const content = anyMsg.content;
              this.emit("event", {
                type: "toolResult",
                threadId,
                toolCallId:
                  (anyMsg.tool_use_id as string) || "",
                output:
                  typeof content === "string"
                    ? content
                    : JSON.stringify(content ?? ""),
                isError: Boolean(anyMsg.is_error),
              } satisfies AgentEvent);
              break;
            }

            case "stream_event": {
              const streamEvent = anyMsg.event as {
                type?: string;
                delta?: { type?: string; text?: string; partial_json?: string };
              };
              if (streamEvent?.type === "content_block_delta") {
                if (
                  streamEvent.delta?.type === "text_delta" &&
                  typeof streamEvent.delta.text === "string" &&
                  streamEvent.delta.text
                ) {
                  this.emit("event", {
                    type: "textDelta",
                    threadId,
                    delta: streamEvent.delta.text,
                  } satisfies AgentEvent);
                } else if (
                  streamEvent.delta?.type === "input_json_delta" &&
                  typeof streamEvent.delta.partial_json === "string" &&
                  streamEvent.delta.partial_json
                ) {
                  this.emit("event", {
                    type: "toolInputDelta",
                    threadId,
                    partialJson: streamEvent.delta.partial_json,
                  } satisfies AgentEvent);
                }
              }
              break;
            }

            case "tool_progress": {
              const toolUseId = (anyMsg.tool_use_id as string | undefined) ?? "";
              const toolName = (anyMsg.tool_name as string | undefined) ?? "unknown";
              const elapsedSeconds = (anyMsg.elapsed_time_seconds as number | undefined) ?? 0;
              if (toolUseId) {
                this.emit("event", {
                  type: "toolProgress",
                  threadId,
                  toolCallId: toolUseId,
                  toolName,
                  elapsedSeconds,
                } satisfies AgentEvent);
              }
              break;
            }
          }
        }
      } catch (e: unknown) {
        const errorMessage =
          e instanceof Error ? e.message : String(e);
        logger.error("SDK stream error", {
          sessionId,
          error: errorMessage,
        });
        this.emit("event", {
          type: "error",
          threadId,
          error: errorMessage,
        } satisfies AgentEvent);
      } finally {
        const current = this.sessions.get(sessionId);
        if (current?.query === q) {
          this.sessions.delete(sessionId);
        }
        logger.info("Session stream ended", { sessionId });
        this.emit(`_streamDone:${sessionId}`);
        if (!suppressEnded && !current?.suppressEnded && (!current || current.query === q)) {
          this.emit("event", {
            type: "ended",
            threadId,
          } satisfies AgentEvent);
        }
      }
    })();
  }

  /** Build a multimodal SDKUserMessage from text and attachments. */
  private async buildMultimodalMessage(
    message: string,
    attachments: AttachmentMeta[],
    sessionId: string,
  ): Promise<SDKUserMessage> {
    const contentBlocks: Array<Record<string, unknown>> = [];

    for (const att of attachments) {
      try {
        const data = await readFile(att.sourcePath);

        if (att.mimeType.startsWith("image/")) {
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: att.mimeType,
              data: data.toString("base64"),
            },
          });
        } else if (att.mimeType === "application/pdf") {
          contentBlocks.push({
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: data.toString("base64"),
            },
          });
        } else if (att.mimeType === "text/plain") {
          contentBlocks.push({
            type: "document",
            source: {
              type: "text",
              media_type: "text/plain",
              data: data.toString("utf-8"),
            },
          });
        }
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : String(err);
        logger.error("Failed to read attachment", {
          id: att.id,
          path: att.sourcePath,
          error: errMsg,
        });
        contentBlocks.push({
          type: "text",
          text: `[Attachment failed to load: ${att.name} - ${errMsg}]`,
        });
      }
    }

    if (message.trim().length > 0) {
      contentBlocks.push({ type: "text", text: message });
    }

    return {
      type: "user" as const,
      message: {
        role: "user" as const,
        content:
          contentBlocks as SDKUserMessage["message"]["content"],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }

  /** Evict sessions that have been idle longer than IDLE_TTL_MS. */
  private evictIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastUsedAt > IDLE_TTL_MS) {
        logger.info("Evicting idle session", { sessionId });
        this.sessions.delete(sessionId);
        entry.closeQueue();
        entry.query.close();
      }
    }
  }

  /** Pre-load an SDK session ID mapping (e.g. from the database on startup). */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    this.sdkSessionIds.set(sessionId, sdkSessionId);
  }

  /** Abort a running session. */
  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.sessions.delete(sessionId);
      entry.closeQueue();
      entry.query.close();
    }
  }

  /**
   * Stop a session and wait for the underlying subprocess to exit.
   * Resolves when the stream loop emits _streamDone or when the timeout
   * elapses — whichever comes first. Safe to call if the session does not
   * exist (resolves immediately). The once-listener is always cleaned up,
   * even on timeout, to prevent EventEmitter listener accumulation.
   */
  async waitForSessionExit(sessionId: string, timeoutMs = 5000): Promise<void> {
    // Register the listener BEFORE checking sessions so we never miss an
    // event that fires between the check and the once() call.
    await new Promise<void>((resolve) => {
      let settled = false;

      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.removeListener(`_streamDone:${sessionId}`, done);
        resolve();
      };

      const timer = setTimeout(done, timeoutMs);
      this.once(`_streamDone:${sessionId}`, done);

      const entry = this.sessions.get(sessionId);
      if (!entry) {
        // No active session — resolve immediately without waiting.
        done();
        return;
      }

      this.sessions.delete(sessionId);
      entry.closeQueue();
      entry.query.close();
    });
  }

  /** Tear down all sessions and release resources. */
  shutdown(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    for (const [, entry] of this.sessions) {
      entry.closeQueue();
      entry.query.close();
    }
    this.sessions.clear();
    this.sdkSessionIds.clear();
    logger.info("ClaudeProvider shutdown complete");
  }
}
