#!/usr/bin/env node

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";

const sessions = new Map(); // sessionId -> AbortController

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

    const abortController = new AbortController();
    sessions.set(sessionId, abortController);

    try {
      if (permissionMode === "full") {
        console.error("[claude-bridge] WARNING: Using dangerouslySkipPermissions for session " + sessionId);
      }

      const options = {
        cwd: cwd || process.cwd(),
        model: model || "claude-sonnet-4-6",
        sessionName: sessionId,
        resume: resumeSession || false,
        permissionMode: permissionMode === "full" ? "dangerouslySkipPermissions" : "default",
        includePartialMessages: true,
        abortController,
      };

      // If resuming, use the session name
      const promptValue = message;

      for await (const msg of query({ prompt: promptValue, options })) {
        if (abortController.signal.aborted) break;

        switch (msg.type) {
          case "assistant": {
            const text = (msg.message?.content || [])
              .filter(b => b.type === "text")
              .map(b => b.text)
              .join("");
            if (text) {
              notify("session.message", {
                sessionId,
                type: "assistant",
                content: text,
                messageId: msg.message?.id || null,
                tokens: msg.message?.usage?.output_tokens ?? null,
              });
            }
            break;
          }

          case "result": {
            notify("session.turnComplete", {
              sessionId,
              reason: msg.subtype || "end_turn",
              costUsd: msg.costUSD ?? null,
              totalTokensIn: msg.totalTokensIn ?? 0,
              totalTokensOut: msg.totalTokensOut ?? 0,
            });
            break;
          }

          case "system": {
            // Forward system events (init, status, hooks)
            notify("session.system", {
              sessionId,
              subtype: msg.subtype || "unknown",
            });
            break;
          }
        }
      }
    } catch (e) {
      notify("session.error", {
        sessionId,
        error: e.message || String(e),
      });
    } finally {
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
