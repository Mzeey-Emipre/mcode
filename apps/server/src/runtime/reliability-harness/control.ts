import { timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import type { WebSocketServer } from "ws";
import { THREAD_CONTROL_OPAQUE_ID_MAX_LENGTH } from "@mcode/contracts";

/** Controls exposed by the opt-in packaged reliability harness. */
export const RELIABILITY_HARNESS_CONTROLS = [
  "server-exit",
  "server-hang",
  "transport-loss",
  "persistence-failure",
  "assistant-stream",
] as const;

/** A reliability harness control name. */
export type ReliabilityHarnessControl = (typeof RELIABILITY_HARNESS_CONTROLS)[number];

/** Versioned capability document shared by the packaged runner and server. */
export interface ReliabilityHarnessCapability {
  readonly version: 1;
  readonly token: string;
  readonly runId: string;
}

/** Command accepted by the private reliability route. */
export interface ReliabilityHarnessCommand {
  readonly control: ReliabilityHarnessControl;
  readonly durationMs?: number;
  readonly threadId?: string;
}

/** Published result from the private deterministic assistant-stream control. */
export interface ReliabilityHarnessAssistantStream {
  readonly threadId: string;
  readonly executionId: string;
  readonly text: string;
}

/** Runtime adapter for deterministic server faults in one isolated run. */
export interface ReliabilityHarnessAdapter {
  readonly enabled: boolean;
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    sockets: WebSocketServer["clients"],
  ): Promise<boolean>;
}

const CAPABILITY_PATH_ENV = "MCODE_RELIABILITY_CAPABILITY_PATH";
const RELIABILITY_PATH = "/__mcode/reliability";
const MAX_BODY_BYTES = 8 * 1024;
const MAX_HANG_MS = 30_000;

/** Read and validate the opt-in capability document, or return null. */
export function readReliabilityHarnessCapability(
  capabilityPath = process.env[CAPABILITY_PATH_ENV],
): ReliabilityHarnessCapability | null {
  if (!capabilityPath || !isAbsolute(capabilityPath)) return null;
  const normalizedPath = resolve(capabilityPath);
  try {
    const stat = lstatSync(normalizedPath);
    if (!stat.isFile()) {
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(normalizedPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    if (
      value.version !== 1 ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.token) ||
      typeof value.runId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.runId)
    ) {
      return null;
    }
    return { version: 1, token: value.token, runId: value.runId };
  } catch {
    return null;
  }
}

/** Build a server adapter only when the explicit capability is present. */
export function createReliabilityHarnessAdapter(
  database: Database.Database,
  capability = readReliabilityHarnessCapability(),
  hooks: {
    readonly blockEventLoop?: (durationMs: number) => void;
    readonly streamAssistant?: (threadId: string) => ReliabilityHarnessAssistantStream;
  } = {},
): ReliabilityHarnessAdapter {
  if (!capability) return { enabled: false, handleRequest: async () => false };

  let persistenceFailure = false;
  const block = hooks.blockEventLoop ?? blockEventLoop;
  const closeSockets = (sockets: WebSocketServer["clients"]): void => {
    for (const socket of sockets) {
      if (socket.readyState === 1) socket.close(1012, "Reliability control");
    }
  };

  return {
    enabled: true,
    async handleRequest(request, response, sockets): Promise<boolean> {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "POST" || requestUrl.pathname !== RELIABILITY_PATH) {
        return false;
      }
      const remoteAddress = request.socket.remoteAddress;
      if (!isLoopbackAddress(remoteAddress)) {
        response.writeHead(403);
        response.end("Forbidden");
        return true;
      }

      const presentedToken = request.headers["x-mcode-reliability-token"];
      if (typeof presentedToken !== "string" || !safeTokenEqual(presentedToken, capability.token)) {
        response.writeHead(401);
        response.end("Unauthorized");
        return true;
      }

      let body: ReliabilityHarnessCommand;
      try {
        body = await readCommand(request);
      } catch (error) {
        response.writeHead(400);
        response.end(error instanceof Error ? error.message : "Invalid command");
        return true;
      }

      let stream: ReliabilityHarnessAssistantStream | undefined;
      try {
        if (body.control === "assistant-stream") {
          if (!hooks.streamAssistant) {
            response.writeHead(409);
            response.end("Assistant stream control is unavailable");
            return true;
          }
          stream = hooks.streamAssistant(body.threadId!);
        }

        response.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ accepted: true, control: body.control, ...(stream ? { stream } : {}) }));
      } catch {
        response.writeHead(500);
        response.end("Reliability control failed");
        return true;
      }

      switch (body.control) {
        case "server-exit":
          setImmediate(() => process.exit(137));
          break;
        case "server-hang":
          setImmediate(() => block(body.durationMs ?? 1_000));
          break;
        case "transport-loss":
          closeSockets(sockets);
          break;
        case "persistence-failure":
          if (!persistenceFailure) {
            database.pragma("query_only = ON");
            persistenceFailure = true;
          }
          break;
        case "assistant-stream":
          break;
      }
      return true;
    },
  };
}

async function readCommand(request: IncomingMessage): Promise<ReliabilityHarnessCommand> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Reliability command is too large");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Reliability command must be JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Reliability command must be an object");
  const value = parsed as Record<string, unknown>;
  if (!(RELIABILITY_HARNESS_CONTROLS as readonly string[]).includes(String(value.control))) {
    throw new Error("Unknown reliability control");
  }
  if (value.durationMs !== undefined && (typeof value.durationMs !== "number" || !Number.isSafeInteger(value.durationMs) || value.durationMs < 1 || value.durationMs > MAX_HANG_MS)) {
    throw new Error(`Reliability hang duration must be between 1 and ${MAX_HANG_MS} milliseconds`);
  }
  if (value.control === "assistant-stream" && (
    typeof value.threadId !== "string"
    || value.threadId.trim().length === 0
    || value.threadId.trim().length > THREAD_CONTROL_OPAQUE_ID_MAX_LENGTH
  )) {
    throw new Error(`Reliability assistant stream requires a thread id up to ${THREAD_CONTROL_OPAQUE_ID_MAX_LENGTH} characters`);
  }
  return {
    control: value.control as ReliabilityHarnessControl,
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs as number }),
    ...(value.control === "assistant-stream" ? { threadId: (value.threadId as string).trim() } : {}),
  };
}

function safeTokenEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function blockEventLoop(durationMs: number): void {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    // Deliberately occupy the event loop for the requested bounded interval.
  }
}
