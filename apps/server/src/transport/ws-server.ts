/**
 * HTTP + WebSocket server setup.
 * Creates an HTTP server for health checks and attachment serving,
 * and a WebSocket server on the same port for RPC + push events.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { logger } from "@mcode/shared";
import { routeMessage, type RouterDeps } from "./ws-router.js";
import { addClient, removeClient } from "./push.js";

/** Create and configure the HTTP + WebSocket server. */
export function createWsServer(deps: RouterDeps): {
  httpServer: Server;
  wss: WebSocketServer;
} {
  const authToken = process.env.MCODE_AUTH_TOKEN;

  const httpServer = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            activeAgents: deps.agentService.activeCount(),
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    },
  );

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // Auth: validate token from query params if configured
    if (authToken) {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const token = url.searchParams.get("token");
      if (token !== authToken) {
        logger.warn("WebSocket connection rejected: invalid token");
        ws.close(4001, "Unauthorized");
        return;
      }
    }

    logger.info("WebSocket client connected");
    addClient(ws);

    ws.on("message", (data: Buffer | string) => {
      const raw =
        typeof data === "string" ? data : data.toString("utf-8");

      routeMessage(raw, deps)
        .then((response) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response));
          }
        })
        .catch((err: unknown) => {
          logger.error("Unexpected router error", {
            error:
              err instanceof Error
                ? err.message
                : String(err),
          });
        });
    });

    ws.on("close", () => {
      logger.info("WebSocket client disconnected");
      removeClient(ws);
    });

    ws.on("error", (err) => {
      logger.error("WebSocket error", { error: err.message });
      removeClient(ws);
    });
  });

  return { httpServer, wss };
}
