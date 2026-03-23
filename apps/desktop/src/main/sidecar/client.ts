/**
 * SidecarClient: imports the Claude Agent SDK directly and runs queries
 * in-process using the v2 persistent session API.
 *
 * Sessions are kept alive in a pool, eliminating per-message MCP server
 * restarts and full conversation history replay on each turn.
 *
 * Emits the same "event" (SidecarEvent) interface as the previous client,
 * keeping compatibility with app-state.ts and index.ts.
 */

import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKSession } from "@anthropic-ai/claude-agent-sdk";
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
  session: SDKSession;
  model: string;
  lastUsedAt: number;
}

/** Idle TTL before a session is evicted (10 minutes). */
const IDLE_TTL_MS = 10 * 60 * 1000;
/** How often to check for idle sessions (1 minute). */
const EVICTION_INTERVAL_MS = 60 * 1000;

export class SidecarClient extends EventEmitter {
  private sessions = new Map<string, SessionEntry>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private ready = true;

  /**
   * Create a new SidecarClient. No child process is spawned; the SDK
   * runs in-process, so the client is immediately ready.
   */
  static start(): SidecarClient {
    const client = new SidecarClient();
    logger.info("SidecarClient started (in-process SDK v2)");
    return client;
  }

  /** Always true; no startup delay since no child process. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Send a user message to a Claude agent session.
   *
   * Uses the v2 persistent session pool: a session is created once per
   * thread and reused across turns. Messages are queued via session.send()
   * and streamed via session.stream().
   *
   * Three-state model:
   *   1. No pool entry + resume=false → createSession()
   *   2. No pool entry + resume=true  → resumeSession()
   *   3. Pool entry exists, same model → session.send() only
   *   4. Pool entry exists, model changed → close old, createSession()
   *
   * @param sessionId - Thread session ID (prefixed with "mcode-")
   * @param message - User message content
   * @param cwd - Working directory for the agent session
   * @param model - Claude model identifier (e.g. "claude-sonnet-4-6")
   * @param resume - Whether to resume a previously persisted session
   * @param permissionMode - "full" maps to bypassPermissions; anything else maps to default
   * @param attachments - Optional file attachments
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

    const sessionOptions = {
      model: resolvedModel,
      executableArgs: ["--cwd", resolvedCwd],
      permissionMode: sdkPermissionMode,
    };

    if (existing && existing.model === resolvedModel) {
      // Reuse existing session — just queue the next message
      existing.lastUsedAt = Date.now();
      await existing.session.send(message);
      return;
    }

    // Close old session if model changed
    if (existing) {
      logger.info("Model changed, closing existing session", { sessionId });
      existing.session.close();
      this.sessions.delete(sessionId);
    }

    // Create or resume a new SDK session
    const session = resume
      ? unstable_v2_resumeSession(uuid, sessionOptions)
      : unstable_v2_createSession(sessionOptions);

    logger.info("Session created", { sessionId, resume, model: resolvedModel, cwd: resolvedCwd });

    const entry: SessionEntry = { session, model: resolvedModel, lastUsedAt: Date.now() };
    this.sessions.set(sessionId, entry);

    // Start the long-lived stream loop before sending the first message
    this.startStreamLoop(sessionId, session);

    // Queue the first message
    const prompt = attachments && attachments.length > 0
      ? await this.buildMultimodalMessage(message, attachments, sessionId)
      : message;
    await session.send(prompt);
  }

  /**
   * Run the persistent stream loop for a session.
   * Processes all events from session.stream() until the stream closes.
   * Cleans up the pool entry and emits session.ended when done.
   */
  private startStreamLoop(sessionId: string, session: SDKSession): void {
    (async () => {
      try {
        let lastAssistantText = "";

        for await (const msg of session.stream()) {
          const entry = this.sessions.get(sessionId);
          if (entry) entry.lastUsedAt = Date.now();

          const anyMsg = msg as Record<string, unknown>;

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
        this.sessions.delete(sessionId);
        logger.info("Session stream ended", { sessionId });
        this.emit("event", {
          method: "session.ended",
          params: { sessionId },
        } as SidecarEvent);
      }
    })();
  }

  /** Build a multimodal SDKUserMessage from text + attachments. */
  private async buildMultimodalMessage(
    message: string,
    attachments: AttachmentMeta[],
    sessionId: string,
  ): Promise<{ role: "user"; content: Array<Record<string, unknown>> }> {
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

    return { role: "user" as const, content: contentBlocks };
  }

  /** Evict sessions that have been idle longer than IDLE_TTL_MS. */
  private evictIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastUsedAt > IDLE_TTL_MS) {
        logger.info("Evicting idle session", { sessionId });
        entry.session.close();
        // Pool entry is removed when the stream loop's finally block runs
      }
    }
  }

  /** Close a specific session's stream. */
  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.session.close();
    }
  }

  /** Close all sessions and stop the eviction timer. */
  shutdown(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    for (const [, entry] of this.sessions) {
      entry.session.close();
    }
    this.sessions.clear();
    logger.info("SidecarClient shutdown complete");
  }
}
