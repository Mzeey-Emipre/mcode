import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
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

/** Versioned capability document shared by the packaged runner and Desktop. */
export interface ReliabilityHarnessCapability {
  readonly version: 1;
  readonly token: string;
  readonly runId: string;
}

/** Command accepted by the local Desktop control plane. */
export interface ReliabilityHarnessCommand {
  readonly control: ReliabilityHarnessControl | "planned-restart";
  readonly durationMs?: number;
  readonly threadId?: string;
}

/** Published result forwarded from the server-only reliability control. */
export interface ReliabilityHarnessForwardResult {
  readonly accepted: true;
  readonly control: ReliabilityHarnessControl;
  readonly stream?: {
    readonly threadId: string;
    readonly executionId: string;
    readonly text: string;
  };
}

const RELIABILITY_FORWARD_RESPONSE_MAX_BYTES = 16 * 1024;
const RELIABILITY_STREAM_TEXT_MAX_LENGTH = 4 * 1024;

/** Read and validate the bounded response from the private server reliability endpoint. */
export async function readReliabilityHarnessForwardResponse(
  response: Response,
  command: ReliabilityHarnessCommand,
): Promise<ReliabilityHarnessForwardResult> {
  if (command.control === "planned-restart") {
    throw new Error("Planned restart is not a server fault");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Reliability server control returned an empty response");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > RELIABILITY_FORWARD_RESPONSE_MAX_BYTES) {
        throw new Error("Reliability server control response is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error("Reliability server control returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Reliability server control returned an invalid response");
  }
  const result = parsed as Record<string, unknown>;
  if (result.accepted !== true || result.control !== command.control) {
    throw new Error("Reliability server control returned an invalid response");
  }
  if (command.control !== "assistant-stream") {
    return { accepted: true, control: command.control };
  }
  const stream = result.stream;
  if (!stream || typeof stream !== "object") {
    throw new Error("Reliability assistant stream returned an invalid response");
  }
  const value = stream as Record<string, unknown>;
  if (
    value.threadId !== command.threadId
    || typeof value.executionId !== "string"
    || value.executionId.length === 0
    || value.executionId.length > THREAD_CONTROL_OPAQUE_ID_MAX_LENGTH
    || typeof value.text !== "string"
    || value.text.length === 0
    || value.text.length > RELIABILITY_STREAM_TEXT_MAX_LENGTH
  ) {
    throw new Error("Reliability assistant stream returned an invalid response");
  }
  return {
    accepted: true,
    control: command.control,
    stream: {
      threadId: command.threadId!,
      executionId: value.executionId,
      text: value.text,
    },
  };
}

/** Rendezvous data written without the capability token. */
export interface ReliabilityHarnessRendezvous {
  readonly version: 1;
  readonly port: number;
  readonly pid: number;
}

/** Narrow callbacks used by the Desktop reliability control plane. */
export interface ReliabilityHarnessControlPlaneCallbacks {
  readonly plannedRestart: () => Promise<void>;
  readonly serverFault: (command: ReliabilityHarnessCommand, token: string) => Promise<ReliabilityHarnessForwardResult | void>;
}

/** Local-only, opt-in Desktop control plane for packaged reliability runs. */
export class ReliabilityHarnessControlPlane {
  private readonly capabilityPath: string;
  private readonly capability: ReliabilityHarnessCapability;
  private readonly callbacks: ReliabilityHarnessControlPlaneCallbacks;
  private server: ReturnType<typeof createServer> | null = null;
  private rendezvousPath: string | null = null;

  /** Construct a control plane from a validated capability file, or remain disabled. */
  constructor(capabilityPath: string, callbacks: ReliabilityHarnessControlPlaneCallbacks) {
    const capability = readReliabilityHarnessCapability(capabilityPath);
    if (!capability) throw new Error("Invalid reliability harness capability");
    this.capabilityPath = resolve(capabilityPath);
    this.capability = capability;
    this.callbacks = callbacks;
  }

  /** Start on a loopback ephemeral port and publish token-free rendezvous data. */
  async start(): Promise<ReliabilityHarnessRendezvous> {
    if (this.server) throw new Error("Reliability harness control plane already started");
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
    const address = server.address() as AddressInfo;
    const rendezvous = { version: 1 as const, port: address.port, pid: process.pid };
    this.rendezvousPath = join(dirname(this.capabilityPath), "desktop-reliability-rendezvous.json");
    writeFileSync(this.rendezvousPath, JSON.stringify(rendezvous), { mode: 0o600 });
    server.unref();
    return rendezvous;
  }

  /** Stop the control plane and remove its rendezvous file. */
  async dispose(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    if (this.rendezvousPath) {
      try {
        unlinkSync(this.rendezvousPath);
      } catch {
        // Cleanup is best effort when the app is exiting.
      }
      this.rendezvousPath = null;
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/__mcode/reliability") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    const authorization = request.headers.authorization;
    const presentedToken = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (!safeTokenEqual(presentedToken, this.capability.token)) {
      response.writeHead(401);
      response.end("Unauthorized");
      return;
    }
    try {
      const command = await readCommand(request);
      let result: ReliabilityHarnessForwardResult | void = undefined;
      if (command.control === "planned-restart") {
        await this.callbacks.plannedRestart();
      } else {
        result = await this.callbacks.serverFault(command, this.capability.token);
        if (command.control === "assistant-stream" && (
          !result?.stream || result.stream.threadId !== command.threadId
        )) {
          throw new Error("Assistant stream control did not return its requested thread");
        }
      }
      response.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ accepted: true, control: command.control, ...(result?.stream ? { stream: result.stream } : {}) }));
    } catch (error) {
      if (!response.headersSent) response.writeHead(400);
      if (!response.writableEnded) response.end(error instanceof Error ? error.message : "Invalid command");
    }
  }
}

/** Read and validate the opt-in capability document. */
export function readReliabilityHarnessCapability(capabilityPath: string): ReliabilityHarnessCapability | null {
  if (!isAbsolute(capabilityPath)) return null;
  const normalizedPath = resolve(capabilityPath);
  try {
    const stat = lstatSync(normalizedPath);
    if (!stat.isFile()) return null;
    const value = JSON.parse(readFileSync(normalizedPath, "utf8")) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.token) ||
      typeof value.runId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.runId)
    ) return null;
    return { version: 1, token: value.token, runId: value.runId };
  } catch {
    return null;
  }
}

async function readCommand(request: IncomingMessage): Promise<ReliabilityHarnessCommand> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 8 * 1024) throw new Error("Reliability command is too large");
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
  const allowed = [...RELIABILITY_HARNESS_CONTROLS, "planned-restart"] as const;
  if (!(allowed as readonly string[]).includes(String(value.control))) throw new Error("Unknown reliability control");
  if (value.durationMs !== undefined && (typeof value.durationMs !== "number" || !Number.isSafeInteger(value.durationMs) || value.durationMs < 1 || value.durationMs > 30_000)) {
    throw new Error("Reliability hang duration is out of bounds");
  }
  if (value.control === "assistant-stream" && (
    typeof value.threadId !== "string"
    || value.threadId.trim().length === 0
    || value.threadId.trim().length > THREAD_CONTROL_OPAQUE_ID_MAX_LENGTH
  )) {
    throw new Error(`Reliability assistant stream requires a thread id up to ${THREAD_CONTROL_OPAQUE_ID_MAX_LENGTH} characters`);
  }
  return {
    control: value.control as ReliabilityHarnessCommand["control"],
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
