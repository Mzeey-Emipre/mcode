#!/usr/bin/env node

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";

const sessions = new Map(); // sessionId -> AbortController
const seenMessageIds = new Set(); // Track message IDs to deduplicate

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

rl.on("line", async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  if (req.method === "session.sendMessage") {
    const { sessionId, message, cwd, model, resumeSession, permissionMode } = req.params;

    // Acknowledge immediately
    send({ jsonrpc: "2.0", id: req.id, result: { ok: true } });

    // Abort any existing session with same ID (prevents duplicate agents)
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.abort();
      sessions.delete(sessionId);
    }

    const abortController = new AbortController();
    sessions.set(sessionId, abortController);

    try {
      if (permissionMode === "full") {
        console.error("[claude-bridge] WARNING: Using dangerouslySkipPermissions for session " + sessionId);
      }
      console.error(`[claude-bridge] Starting query for session ${sessionId}, resume=${resumeSession}, model=${model}, cwd=${cwd}`);

      const options = {
        cwd: cwd || process.cwd(),
        model: model || "claude-sonnet-4-6",
        sessionName: sessionId,
        resume: resumeSession || false,
        permissionMode: permissionMode === "full" ? "dangerouslySkipPermissions" : "default",
        abortController,
      };

      let lastAssistantText = "";

      for await (const msg of query({ prompt: message, options })) {
        if (abortController.signal.aborted) break;

        switch (msg.type) {
          case "assistant": {
            const text = (msg.message?.content || [])
              .filter(b => b.type === "text")
              .map(b => b.text)
              .join("");

            // Deduplicate: only emit if text is different from last seen
            // The SDK can emit multiple assistant messages (partial + final)
            if (text && text !== lastAssistantText) {
              // If we had a previous partial, this is the updated version
              // Only keep the latest (longest) version
              lastAssistantText = text;
            }
            break;
          }

          case "result": {
            // Turn complete - emit the final accumulated text
            if (lastAssistantText) {
              notify("session.message", {
                sessionId,
                type: "assistant",
                content: lastAssistantText,
                messageId: null,
                tokens: msg.totalTokensOut ?? null,
              });
            }

            notify("session.turnComplete", {
              sessionId,
              reason: msg.subtype || "end_turn",
              costUsd: msg.costUSD ?? null,
              totalTokensIn: msg.totalTokensIn ?? 0,
              totalTokensOut: msg.totalTokensOut ?? 0,
            });

            // Reset for next turn
            lastAssistantText = "";
            break;
          }

          case "system": {
            notify("session.system", {
              sessionId,
              subtype: msg.subtype || "unknown",
            });
            break;
          }
        }
      }
    } catch (e) {
      console.error(`[claude-bridge] Error in session ${sessionId}:`, e.message || String(e));
      notify("session.error", {
        sessionId,
        error: e.message || String(e),
      });
    } finally {
      console.error(`[claude-bridge] Session ${sessionId} ended`);
      sessions.delete(sessionId);
      notify("session.ended", { sessionId });
    }
  }

  if (req.method === "session.stop") {
    const controller = sessions.get(req.params?.sessionId);
    if (controller) {
      controller.abort();
    }
    send({ jsonrpc: "2.0", id: req.id, result: { ok: true } });
  }

  if (req.method === "ping") {
    send({ jsonrpc: "2.0", id: req.id, result: { pong: true } });
  }
});

// Handle process signals gracefully
process.on("SIGTERM", () => {
  for (const [, controller] of sessions) {
    controller.abort();
  }
  process.exit(0);
});

process.on("SIGINT", () => {
  for (const [, controller] of sessions) {
    controller.abort();
  }
  process.exit(0);
});

// Signal readiness
notify("bridge.ready", {});
