/**
 * SidecarClient: imports the Claude Agent SDK directly and runs queries
 * in-process instead of spawning a child process.
 *
 * Emits the same "event" (SidecarEvent) interface as the old JSON-RPC client,
 * keeping compatibility with app-state.ts and index.ts.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "events";
import { readFile } from "fs/promises";
import type { SidecarEvent } from "./types.js";
import { logger } from "../logger.js";
import type { AttachmentMeta } from "../models.js";

export interface SidecarClientEvents {
  event: [SidecarEvent];
  error: [Error];
}

export class SidecarClient extends EventEmitter {
  private sessions = new Map<string, AbortController>();
  private ready = true;

  /**
   * Create a new SidecarClient. No child process is spawned; the SDK
   * runs in-process, so the client is immediately ready.
   */
  static start(): SidecarClient {
    const client = new SidecarClient();
    logger.info("SidecarClient started (in-process SDK)");
    return client;
  }

  /** Always true; no startup delay since no child process. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Send a user message to a Claude agent session.
   *
   * Runs the SDK query() async generator in-process and emits SidecarEvents
   * on the same EventEmitter interface the old JSON-RPC client used.
   *
   * SDK options include settingSources (user/project/local) to load CLAUDE.md,
   * skills, hooks, and settings; the claude_code system prompt preset; and the
   * full Claude Code tool surface.
   *
   * @param sessionId - Thread session ID (prefixed with "mcode-")
   * @param message - User message content
   * @param cwd - Working directory for the agent session
   * @param model - Claude model identifier (e.g. "claude-sonnet-4-6")
   * @param resume - Whether to resume an existing session or start a new one
   * @param permissionMode - "full" maps to bypassPermissions; anything else maps to default
   */
  async sendMessage(
    sessionId: string,
    message: string,
    cwd: string,
    model: string,
    resume: boolean,
    permissionMode: string,
    attachments?: AttachmentMeta[],
  ): Promise<void> {
    // Abort any existing session with the same ID to prevent duplicates
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.abort();
      this.sessions.delete(sessionId);
    }

    const abortController = new AbortController();
    this.sessions.set(sessionId, abortController);

    // Extract UUID from "mcode-{uuid}" format for SDK session identity
    const uuid = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;

    const isBypass = permissionMode === "full";
    if (isBypass) {
      logger.warn("Using bypassPermissions for session", { sessionId });
    }
    logger.info("Starting SDK query", { sessionId, resume, model, cwd });

    const options = {
      cwd: cwd || process.cwd(),
      model: model || "claude-sonnet-4-6",
      // First message: set sessionId to pin the UUID; subsequent: resume by UUID
      ...(resume ? { resume: uuid } : { sessionId: uuid }),
      permissionMode: isBypass ? ("bypassPermissions" as const) : ("default" as const),
      ...(isBypass ? { allowDangerouslySkipPermissions: true } : {}),
      abortController,
      // Load CLAUDE.md, skills, hooks, and settings from user + project config
      settingSources: ["user" as const, "project" as const, "local" as const],
      // Activate Claude Code system prompt so the agent respects slash commands and conventions
      systemPrompt: { type: "preset" as const, preset: "claude_code" as const },
      // Enable Claude Code tools (Read, Write, Edit, Bash, Glob, Grep, Agent, etc.)
      tools: { type: "preset" as const, preset: "claude_code" as const },
    };

    try {
      let lastAssistantText = "";
      const hasAttachments = attachments && attachments.length > 0;
      const prompt = hasAttachments
        ? this.buildMultimodalPrompt(message, attachments, sessionId)
        : message;
      const q = query({ prompt, options });

      // When resuming a session, the model from the original session persists.
      // Call setModel() to switch to the user's current selection.
      if (resume && model) {
        q.setModel(model).catch(() => {
          // setModel may fail if streaming input isn't supported; ignore
        });
      }

      for await (const msg of q) {
        if (abortController.signal.aborted) break;

        switch (msg.type) {
          case "assistant": {
            const contentBlocks = msg.message?.content || [];
            const text = contentBlocks
              .filter((b: { type: string }) => b.type === "text")
              .map((b: { type: string; text?: string }) => b.text ?? "")
              .join("");

            // Deduplicate: only update if text changed
            if (text && text !== lastAssistantText) {
              lastAssistantText = text;
            }

            // Extract tool_use blocks from the assistant message content
            for (const block of contentBlocks) {
              if (block.type === "tool_use") {
                const toolBlock = block as { type: string; id?: string; name?: string; input?: Record<string, unknown> };
                this.emit("event", {
                  method: "session.toolUse",
                  params: {
                    sessionId,
                    toolCallId: toolBlock.id || null,
                    toolName: toolBlock.name || "unknown",
                    toolInput: toolBlock.input || {},
                  },
                } as SidecarEvent);
              }
            }
            break;
          }

          case "result": {
            const resultMsg = msg as {
              type: string;
              stop_reason?: string;
              subtype?: string;
              total_cost_usd?: number;
              usage?: { input_tokens?: number; output_tokens?: number };
            };

            // Emit the final accumulated text as a session.message
            if (lastAssistantText) {
              this.emit("event", {
                method: "session.message",
                params: {
                  sessionId,
                  type: "assistant",
                  content: lastAssistantText,
                  messageId: null,
                  tokens: resultMsg.usage?.output_tokens ?? null,
                },
              } as SidecarEvent);
            }

            this.emit("event", {
              method: "session.turnComplete",
              params: {
                sessionId,
                reason: resultMsg.stop_reason || resultMsg.subtype || "end_turn",
                costUsd: resultMsg.total_cost_usd ?? null,
                totalTokensIn: resultMsg.usage?.input_tokens ?? 0,
                totalTokensOut: resultMsg.usage?.output_tokens ?? 0,
              },
            } as SidecarEvent);

            // Reset for next turn
            lastAssistantText = "";
            break;
          }

          case "system": {
            const sysMsg = msg as { type: string; subtype?: string };
            this.emit("event", {
              method: "session.system",
              params: {
                sessionId,
                subtype: sysMsg.subtype || "unknown",
              },
            } as SidecarEvent);
            break;
          }

          default: {
            // Handle tool_use and tool_result event types from the SDK
            const anyMsg = msg as Record<string, unknown>;

            if (anyMsg.type === "tool_use") {
              this.emit("event", {
                method: "session.toolUse",
                params: {
                  sessionId,
                  toolCallId: (anyMsg.id as string) || null,
                  toolName: (anyMsg.tool_name as string) || (anyMsg.name as string) || "unknown",
                  toolInput: (anyMsg.tool_input as Record<string, unknown>) || (anyMsg.input as Record<string, unknown>) || {},
                },
              } as SidecarEvent);
            }

            if (anyMsg.type === "tool_result") {
              const content = anyMsg.content;
              this.emit("event", {
                method: "session.toolResult",
                params: {
                  sessionId,
                  toolCallId: (anyMsg.tool_use_id as string) || null,
                  output: typeof content === "string"
                    ? content
                    : JSON.stringify(content ?? ""),
                  isError: Boolean(anyMsg.is_error),
                },
              } as SidecarEvent);
            }
            break;
          }
        }
      }
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      logger.error("SDK query error", { sessionId, error: errorMessage });
      this.emit("event", {
        method: "session.error",
        params: {
          sessionId,
          error: errorMessage,
        },
      } as SidecarEvent);
    } finally {
      this.sessions.delete(sessionId);
      logger.info("Session ended", { sessionId });
      this.emit("event", {
        method: "session.ended",
        params: { sessionId },
      } as SidecarEvent);
    }
  }

  private async *buildMultimodalPrompt(
    message: string,
    attachments: AttachmentMeta[],
    sessionId: string,
  ): AsyncGenerator<{
    type: "user";
    session_id: string;
    parent_tool_use_id: null;
    message: { role: "user"; content: Array<Record<string, unknown>> };
  }> {
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
        logger.error("Failed to read attachment", {
          id: att.id,
          path: att.sourcePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    contentBlocks.push({ type: "text", text: message });

    yield {
      type: "user" as const,
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: "user" as const,
        content: contentBlocks,
      },
    };
  }

  /** Abort a running session. */
  stopSession(sessionId: string): void {
    const controller = this.sessions.get(sessionId);
    if (controller) {
      controller.abort();
    }
  }

  /** Abort all running sessions. */
  shutdown(): void {
    for (const [, controller] of this.sessions) {
      controller.abort();
    }
    this.sessions.clear();
    logger.info("SidecarClient shutdown complete");
  }
}
