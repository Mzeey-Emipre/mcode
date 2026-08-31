import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeHTTP from "node:http";
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
    request: NodeHTTP.IncomingMessage,
    response: NodeHTTP.ServerResponse,
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
  if (!capabilityPath || !NodePath.isAbsolute(capabilityPath)) return null;
  const normalizedPath = NodePath.resolve(capabilityPath);
  try {
    const stat = NodeFS.lstatSync(normalizedPath);
    if (!stat.isFile()) return null;
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(normalizedPath, "utf8"));
    return parseReliabilityHarnessCapability(parsed);
  } catch {
    return null;
  }
}

function parseReliabilityHarnessCapability(value: unknown): ReliabilityHarnessCapability | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !isCapabilityToken(record.token) || !isCapabilityRunId(record.runId)) {
    return null;
  }
  return { version: 1, token: record.token, runId: record.runId };
}

function isCapabilityToken(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isCapabilityRunId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
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
      if (request.method !== "POST" || requestUrl.pathname !== RELIABILITY_PATH) return false;
      if (!authorizeReliabilityRequest(request, response, capability)) return true;
      const body = await readReliabilityCommand(request, response);
      if (!body) return true;
      const stream = executeAssistantStream(body, hooks, response);
      if (stream === undefined) return true;
      response.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ accepted: true, control: body.control, ...(stream ? { stream } : {}) }));
      persistenceFailure = executeReliabilityControl(
        body,
        sockets,
        block,
        database,
        persistenceFailure,
        closeSockets,
      );
      return true;
    },
  };
}

function authorizeReliabilityRequest(
  request: NodeHTTP.IncomingMessage,
  response: NodeHTTP.ServerResponse,
  capability: ReliabilityHarnessCapability,
): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    response.writeHead(403);
    response.end("Forbidden");
    return false;
  }
  const token = request.headers["x-mcode-reliability-token"];
  if (typeof token === "string" && safeTokenEqual(token, capability.token)) return true;
  response.writeHead(401);
  response.end("Unauthorized");
  return false;
}

async function readReliabilityCommand(
  request: NodeHTTP.IncomingMessage,
  response: NodeHTTP.ServerResponse,
): Promise<ReliabilityHarnessCommand | null> {
  try {
    return await readCommand(request);
  } catch (error) {
    response.writeHead(400);
    response.end(error instanceof Error ? error.message : "Invalid command");
    return null;
  }
}

function executeAssistantStream(
  command: ReliabilityHarnessCommand,
  hooks: { readonly streamAssistant?: (threadId: string) => ReliabilityHarnessAssistantStream },
  response: NodeHTTP.ServerResponse,
): ReliabilityHarnessAssistantStream | null | undefined {
  if (command.control !== "assistant-stream") return null;
  if (!hooks.streamAssistant) {
    response.writeHead(409);
    response.end("Assistant stream control is unavailable");
    return undefined;
  }
  try {
    return hooks.streamAssistant(command.threadId!);
  } catch {
    response.writeHead(500);
    response.end("Reliability control failed");
    return undefined;
  }
}

function executeReliabilityControl(
  command: ReliabilityHarnessCommand,
  sockets: WebSocketServer["clients"],
  block: (durationMs: number) => void,
  database: Database.Database,
  persistenceFailure: boolean,
  closeSockets: (sockets: WebSocketServer["clients"]) => void,
): boolean {
  switch (command.control) {
    case "server-exit":
      setImmediate(() => process.exit(137));
      return persistenceFailure;
    case "server-hang":
      setImmediate(() => block(command.durationMs ?? 1_000));
      return persistenceFailure;
    case "transport-loss":
      closeSockets(sockets);
      return persistenceFailure;
    case "persistence-failure":
      if (!persistenceFailure) database.pragma("query_only = ON");
      return true;
    case "assistant-stream":
      return persistenceFailure;
  }
}

async function readCommand(request: NodeHTTP.IncomingMessage): Promise<ReliabilityHarnessCommand> {
  const parsed = parseReliabilityCommandJson(await readReliabilityBody(request));
  if (!parsed || typeof parsed !== "object") throw new Error("Reliability command must be an object");
  const value = parsed as Record<string, unknown>;
  const control = parseReliabilityControl(value.control);
  const durationMs = parseReliabilityDuration(value.durationMs);
  const threadId = parseAssistantThreadId(control, value.threadId);
  return {
    control,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(threadId === undefined ? {} : { threadId }),
  };
}

async function readReliabilityBody(request: NodeHTTP.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Reliability command is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseReliabilityCommandJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Reliability command must be JSON");
  }
}

function parseReliabilityControl(value: unknown): ReliabilityHarnessControl {
  if (!(RELIABILITY_HARNESS_CONTROLS as readonly string[]).includes(String(value))) {
    throw new Error("Unknown reliability control");
  }
  return value as ReliabilityHarnessControl;
}

function parseReliabilityDuration(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_HANG_MS) {
    return value;
  }
  throw new Error(`Reliability hang duration must be between 1 and ${MAX_HANG_MS} milliseconds`);
}

function parseAssistantThreadId(
  control: ReliabilityHarnessControl,
  value: unknown,
): string | undefined {
  if (control !== "assistant-stream") return undefined;
  if (typeof value === "string" && value.trim().length > 0 && value.trim().length <= THREAD_CONTROL_OPAQUE_ID_MAX_LENGTH) {
    return value.trim();
  }
  throw new Error(`Reliability assistant stream requires a thread id up to ${THREAD_CONTROL_OPAQUE_ID_MAX_LENGTH} characters`);
}

function safeTokenEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return NodeCrypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
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
