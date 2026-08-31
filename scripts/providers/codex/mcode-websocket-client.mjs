import * as NodeHTTP from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const require = NodeModule.createRequire(NodePath.join(REPO_ROOT, "apps", "web", "package.json"));
const { WebSocket } = require("ws");

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const healthRequest = NodeHTTP.request({ host: "127.0.0.1", port, path: "/health", method: "GET" }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    healthRequest.on("error", reject);
    healthRequest.end();
  });
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function settleResponse(pending, message, formatError) {
  if (typeof message.id !== "string" || !pending.has(message.id)) return false;
  const { resolve, reject, method } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) {
    reject(new Error(formatError(method, message.error)));
  } else {
    resolve(message.result);
  }
  return true;
}

/** Connects a standalone probe to the local Mcode WebSocket API. */
export async function connectMcodeWebSocket({
  port = Number(process.env.MCODE_PORT || 19400),
  onHealth,
  onOpen,
  onPush,
  formatError = (method, error) => `${method}: ${error.message}`,
}) {
  const health = await getHealth(port);
  onHealth?.(health);
  const websocket = new WebSocket(`ws://127.0.0.1:${port}/?token=${health.authToken}`);
  const pending = new Map();
  let nextId = 1;
  let resolveOpen;
  const opened = new Promise((resolve) => {
    resolveOpen = resolve;
  });

  function rpc(method, params) {
    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      websocket.send(JSON.stringify({ id, method, params }));
    });
  }

  websocket.on("open", () => {
    onOpen?.();
    resolveOpen();
  });
  websocket.on("message", (raw) => {
    const message = parseMessage(raw);
    if (!message || settleResponse(pending, message, formatError) || message.type !== "push") return;
    onPush(message);
  });
  await opened;
  return { rpc, close: () => websocket.close() };
}
