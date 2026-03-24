/**
 * SidecarClient: imports the Claude Agent SDK directly and runs queries
 * in-process using the v1 query() API with a prompt queue pattern.
 *
 * Each session holds a long-lived query() backed by an AsyncIterable prompt
 * queue. Pushing messages to the queue feeds them to the SDK subprocess
 * without cold-starting, keeping MCP servers alive across turns.
 *
 * Emits the same "event" (SidecarEvent) interface as before, keeping
 * compatibility with app-state.ts and index.ts.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "events";
import { readFile } from "fs/promises";
import type { SidecarEvent } from "./types.js";
import { logger } from "../logger.js";
import type { AttachmentMeta } from "../models.js";

export interface SidecarClientEvents {
  event: [SidecarEvent];
  error: [Error];
}

interface SessionEntry {
  query: Query;
  pushMessage: (msg: SDKUserMessage) => void;
  closeQueue: () => void;
  model: string;
  lastUsedAt: number;
}

/** Idle TTL before a session is evicted (10 minutes). */
const IDLE_TTL_MS = 10 * 60 * 1000;
/** How often to check for idle sessions (1 minute). */
const EVICTION_INTERVAL_MS = 60 * 1000;

/**
 * Create an async iterable prompt queue backed by a simple push/pull bridge.
 * Messages pushed via `push()` are yielded by the iterable. Calling `close()`
 * terminates the iterator, signaling the SDK to shut down the subprocess.
 */
/** Max queued messages before push() warns and drops. */
const MAX_QUEUE_DEPTH = 20;

function createPromptQueue(): {
  push: (msg: SDKUserMessage) => void;
  close: () => void;
  iterable: AsyncIterable<SDKUserMessage>;
} {
  const pending: SDKUserMessage[] = [];
  let waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  let done = false;

  const push = (msg: SDKUserMessage): void => {
    if (done) return;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: msg, done: false });
    } else {
      if (pending.length >= MAX_QUEUE_DEPTH) {
        logger.warn("Prompt queue full, dropping message", { depth: pending.length });
        return;
      }
      pending.push(msg);
    }
  };

  const close = (): void => {
    done = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  };

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
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

/**
 * Convert a plain string message into an SDKUserMessage.
 */
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

export class SidecarClient extends EventEmitter {
  private sessions = new Map<string, SessionEntry>();
  /** Maps our mcode session ID to the SDK's internal session ID for resume. */
  private sdkSessionIds = new Map<string, string>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private ready = true;

  /**
   * Create a new SidecarClient. No child process is spawned; the SDK
   * runs in-process, so the client is immediately ready.
   */
  static start(): SidecarClient {
    const client = new SidecarClient();
    logger.info("SidecarClient started (in-process SDK v1 query)");
    return client;
  }

  /** Always true; no startup delay since no child process. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Send a user message to a Claude agent session.
   *
   * Uses the v1 query() prompt queue pattern: a query is started once per
   * thread with an AsyncIterable prompt. Subsequent messages are pushed to
   * the queue without restarting the subprocess.
   *
   * Session states:
   *   1. No pool entry + resume=false -> new query()
   *   2. No pool entry + resume=true  -> query() with { resume: sdkSessionId }
   *   3. Pool entry exists, same model -> push to queue
   *   4. Pool entry exists, model changed -> setModel() + push to queue
   */
  sendMessage(
    sessionId: string,
    message: string,
    cwd: string,
    model: string,
    resume: boolean,
    permissionMode: string,
    attachments?: AttachmentMeta[],
  ): void {
    this.doSendMessage(sessionId, message, cwd, model, resume, permissionMode, attachments).catch(
      (e: unknown) => {
        logger.error("Unexpected sendMessage error", { sessionId, error: String(e) });
      },
    );
  }

  private async doSendMessage(
    sessionId: string,
    message: string,
    cwd: string,
    model: string,
    resume: boolean,
    permissionMode: string,
    attachments?: AttachmentMeta[],
  ): Promise<void> {
    // Start eviction timer lazily so fake timers in tests work correctly
    if (!this.evictionTimer) {
      this.evictionTimer = setInterval(() => this.evictIdleSessions(), EVICTION_INTERVAL_MS);
    }

    const existing = this.sessions.get(sessionId);
    const isBypass = permissionMode === "full";
    const sdkPermissionMode = isBypass ? ("bypassPermissions" as const) : ("default" as const);
    const uuid = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
    const resolvedCwd = cwd || process.cwd();
    const resolvedModel = model || "claude-sonnet-4-6";

    if (isBypass) {
      logger.warn("Using bypassPermissions for session", { sessionId });
    }

    // Build the user message (with attachments if present)
    const prompt = attachments && attachments.length > 0
      ? await this.buildMultimodalMessage(message, attachments, sessionId)
      : toUserMessage(message, sessionId);

    if (existing) {
      // Reuse existing session
      existing.lastUsedAt = Date.now();

      if (existing.model !== resolvedModel) {
        // Model changed: use setModel() instead of close/recreate
        logger.info("Model changed, calling setModel()", { sessionId, model: resolvedModel });
        try {
          await existing.query.setModel(resolvedModel);
          existing.model = resolvedModel;
        } catch (err) {
          logger.error("setModel() failed, closing session for recreation", {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          existing.closeQueue();
          existing.query.close();
          this.sessions.delete(sessionId);
          // Fall through to create a new query below
          return this.doSendMessage(sessionId, message, cwd, model, false, permissionMode, attachments);
        }
      }

      existing.pushMessage(prompt);
      return;
    }

    // Build v1 query options with full settings support
    const resumeId = this.sdkSessionIds.get(sessionId) ?? uuid;
    const baseOptions = {
      cwd: resolvedCwd,
      model: resolvedModel,
      settingSources: ["user" as const, "project" as const, "local" as const],
      systemPrompt: { type: "preset" as const, preset: "claude_code" as const },
      tools: { type: "preset" as const, preset: "claude_code" as const },
      permissionMode: sdkPermissionMode,
      ...(isBypass && { allowDangerouslySkipPermissions: true }),
    };
    const options = resume
      ? { ...baseOptions, resume: resumeId }
      : { ...baseOptions, sessionId: uuid };

    const queue = createPromptQueue();

    logger.info("Starting query()", { sessionId, resume, resumeId, model: resolvedModel, cwd: resolvedCwd });

    const q = sdkQuery({ prompt: queue.iterable, options });

    const entry: SessionEntry = {
      query: q,
      pushMessage: queue.push,
      closeQueue: queue.close,
      model: resolvedModel,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(sessionId, entry);

    // Start the stream loop, then push the first message
    if (resume) {
      const retryPromise = new Promise<boolean>((resolve) => {
        const resumeHandler = () => {
          this.removeListener(`_streamDone:${sessionId}`, doneHandler);
          resolve(true);
        };
        const doneHandler = () => {
          this.removeListener(`_resumeFailed:${sessionId}`, resumeHandler);
          resolve(false);
        };
        this.once(`_resumeFailed:${sessionId}`, resumeHandler);
        this.once(`_streamDone:${sessionId}`, doneHandler);
      });

      this.startStreamLoop(sessionId, q);
      queue.push(prompt);

      const needsRetry = await retryPromise;
      if (needsRetry) {
        logger.info("Resume failed, falling back to fresh query()", { sessionId });
        this.sdkSessionIds.delete(sessionId);

        const freshQueue = createPromptQueue();
        const freshOptions = { ...baseOptions, sessionId: uuid };

        const freshQ = sdkQuery({ prompt: freshQueue.iterable, options: freshOptions });
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

  /**
   * Run the stream loop for a query.
   * Iterates the Query async generator, processes all SDK events,
   * and cleans up the pool entry when the stream ends.
   */
  private startStreamLoop(sessionId: string, q: Query): void {
    (async () => {
      try {
        let lastAssistantText = "";
        let sessionInitialized = false;

        for await (const msg of q) {
          const entry = this.sessions.get(sessionId);
          if (entry) entry.lastUsedAt = Date.now();

          const anyMsg = msg as Record<string, unknown>;

          // Diagnostic: log every event type for debugging stream issues
          logger.info("Stream event", {
            sessionId,
            type: anyMsg.type,
            subtype: (anyMsg.subtype as string) ?? undefined,
            ...(anyMsg.type === "result" && anyMsg.subtype !== "success" && {
              errors: anyMsg.errors,
              is_error: anyMsg.is_error,
            }),
          });

          // Mark session as successfully initialized on first non-error event
          if (!sessionInitialized && anyMsg.type !== "result") {
            sessionInitialized = true;
          }

          // Only capture SDK session ID from successful sessions.
          const sdkSid = anyMsg.session_id as string | undefined;
          if (sdkSid && sessionInitialized && !this.sdkSessionIds.has(sessionId)) {
            this.sdkSessionIds.set(sessionId, sdkSid);
            logger.info("Captured SDK session ID", { sessionId, sdkSessionId: sdkSid });
            this.emit("event", {
              method: "session.sdkSessionId",
              params: { sessionId, sdkSessionId: sdkSid },
            } as SidecarEvent);
          }

          // Detect failed resume and clear stale SDK session ID
          if (
            anyMsg.type === "result" &&
            anyMsg.is_error === true &&
            !sessionInitialized
          ) {
            const errors = anyMsg.errors as string[] | undefined;
            const isNoConversation = errors?.some((e) =>
              typeof e === "string" && e.includes("No conversation found"),
            );
            if (isNoConversation) {
              logger.warn("Resume failed: conversation not found, will retry with fresh query()", { sessionId });
              this.sdkSessionIds.delete(sessionId);
              this.emit("event", {
                method: "session.sdkSessionId",
                params: { sessionId, sdkSessionId: "" },
              } as SidecarEvent);
              this.emit("event", {
                method: "session.system",
                params: {
                  sessionId,
                  subtype: "session_restarted",
                },
              } as SidecarEvent);
              this.emit(`_resumeFailed:${sessionId}`);
              return;
            }
          }

          switch (anyMsg.type) {
            case "assistant": {
              const contentBlocks =
                (anyMsg.message as { content?: Array<Record<string, unknown>> })?.content ?? [];
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
                    method: "session.toolUse",
                    params: {
                      sessionId,
                      toolCallId: (block.id as string) || null,
                      toolName: (block.name as string) || "unknown",
                      toolInput: (block.input as Record<string, unknown>) || {},
                    },
                  } as SidecarEvent);
                }
              }
              break;
            }

            case "result": {
              if (lastAssistantText) {
                this.emit("event", {
                  method: "session.message",
                  params: {
                    sessionId,
                    type: "assistant",
                    content: lastAssistantText,
                    messageId: null,
                    tokens:
                      (anyMsg.usage as { output_tokens?: number })?.output_tokens ?? null,
                  },
                } as SidecarEvent);
              }

              this.emit("event", {
                method: "session.turnComplete",
                params: {
                  sessionId,
                  reason:
                    (anyMsg.stop_reason as string) ||
                    (anyMsg.subtype as string) ||
                    "end_turn",
                  costUsd: (anyMsg.total_cost_usd as number) ?? null,
                  totalTokensIn:
                    (anyMsg.usage as { input_tokens?: number })?.input_tokens ?? 0,
                  totalTokensOut:
                    (anyMsg.usage as { output_tokens?: number })?.output_tokens ?? 0,
                },
              } as SidecarEvent);

              lastAssistantText = "";
              break;
            }

            case "system": {
              this.emit("event", {
                method: "session.system",
                params: {
                  sessionId,
                  subtype: (anyMsg.subtype as string) || "unknown",
                },
              } as SidecarEvent);
              break;
            }

            case "tool_use": {
              this.emit("event", {
                method: "session.toolUse",
                params: {
                  sessionId,
                  toolCallId: (anyMsg.id as string) || null,
                  toolName:
                    (anyMsg.tool_name as string) || (anyMsg.name as string) || "unknown",
                  toolInput:
                    (anyMsg.tool_input as Record<string, unknown>) ||
                    (anyMsg.input as Record<string, unknown>) ||
                    {},
                },
              } as SidecarEvent);
              break;
            }

            case "tool_result": {
              const content = anyMsg.content;
              this.emit("event", {
                method: "session.toolResult",
                params: {
                  sessionId,
                  toolCallId: (anyMsg.tool_use_id as string) || null,
                  output:
                    typeof content === "string" ? content : JSON.stringify(content ?? ""),
                  isError: Boolean(anyMsg.is_error),
                },
              } as SidecarEvent);
              break;
            }
          }
        }
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logger.error("SDK stream error", { sessionId, error: errorMessage });
        this.emit("event", {
          method: "session.error",
          params: { sessionId, error: errorMessage },
        } as SidecarEvent);
      } finally {
        // Only delete the pool entry if it still belongs to this query.
        // During resume-failed retry, a fresh entry may have replaced ours.
        const current = this.sessions.get(sessionId);
        if (current?.query === q) {
          this.sessions.delete(sessionId);
        }
        logger.info("Session stream ended", { sessionId });
        this.emit(`_streamDone:${sessionId}`);
        // Only emit session.ended if this query still owns the session.
        // Avoids premature "ended" when a retry stream is already running.
        if (!current || current.query === q) {
          this.emit("event", {
            method: "session.ended",
            params: { sessionId },
          } as SidecarEvent);
        }
      }
    })();
  }

  /** Build a multimodal SDKUserMessage from text + attachments. */
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
        const errMsg = err instanceof Error ? err.message : String(err);
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

    contentBlocks.push({ type: "text", text: message });

    return {
      type: "user" as const,
      message: {
        role: "user" as const,
        content: contentBlocks as SDKUserMessage["message"]["content"],
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

  /** Close a specific session's query. */
  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.sessions.delete(sessionId);
      entry.closeQueue();
      entry.query.close();
    }
  }

  /** Close all sessions and stop the eviction timer. */
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
    logger.info("SidecarClient shutdown complete");
  }
}
