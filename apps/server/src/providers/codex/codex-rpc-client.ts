/**
 * Low-level JSON-RPC 2.0 client for the `codex app-server` NDJSON interface.
 *
 * Serializes outbound requests/notifications to stdin and parses inbound
 * NDJSON lines from stdout, resolving or rejecting pending request promises
 * and emitting events for server-initiated messages.
 */

import { EventEmitter } from "events";
import type { Writable, Readable } from "stream";
import { logger } from "@mcode/shared";

/** Default timeout in milliseconds for RPC requests. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Internal record tracking an in-flight request. */
interface PendingRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * JSON-RPC 2.0 client that communicates with `codex app-server` over stdin/stdout.
 *
 * Emits:
 * - `notification` - a JSON-RPC notification pushed by the server (no `id`)
 * - `serverRequest` - a server-initiated JSON-RPC request (has both `id` and `method`)
 */
export class CodexRpcClient extends EventEmitter {
  private readonly stdin: Writable;
  private readonly stdout: Readable;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private disposed = false;
  private lineBuffer = "";

  private readonly onData: (chunk: Buffer | string) => void;
  private readonly onClose: () => void;
  private readonly onError: (err: Error) => void;

  /**
   * Creates a new CodexRpcClient and immediately starts listening on stdout.
   *
   * @param stdin - Writable stream connected to the codex app-server process stdin.
   * @param stdout - Readable stream connected to the codex app-server process stdout.
   */
  constructor(stdin: Writable, stdout: Readable) {
    super();
    this.stdin = stdin;
    this.stdout = stdout;

    this.onData = (chunk: Buffer | string) => {
      this.lineBuffer += chunk.toString();
      const lines = this.lineBuffer.split("\n");
      // Keep the last (potentially incomplete) segment in the buffer
      this.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        this.processLine(line);
      }
    };

    this.onClose = () => {
      this.rejectAll(new Error("Stream closed while waiting for response"));
    };

    this.onError = (err: Error) => {
      logger.error("CodexRpcClient: stdout stream error", { err });
      this.rejectAll(new Error(`Stream error: ${err.message}`));
    };

    this.stdout.on("data", this.onData);
    this.stdout.on("close", this.onClose);
    this.stdout.on("end", this.onClose);
    this.stdout.on("error", this.onError);
  }

  /**
   * Sends a JSON-RPC request and resolves with the server's result.
   *
   * @param method - The RPC method name.
   * @param params - The parameters to send with the request.
   * @param timeoutMs - Milliseconds before the request is rejected. Defaults to 20 000.
   * @returns A promise that resolves with the response result or rejects on error or timeout.
   */
  sendRequest<TParams, TResult>(
    method: string,
    params: TParams,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<TResult> {
    if (this.disposed) {
      return Promise.reject(new Error("RPC client is disposed"));
    }

    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.stdin.write(message);
    });
  }

  /**
   * Sends a JSON-RPC notification (fire-and-forget; no response expected).
   *
   * @param method - The RPC method name.
   * @param params - Optional parameters to include in the notification.
   */
  sendNotification(method: string, params?: unknown): void {
    if (this.disposed) {
      logger.warn("CodexRpcClient: sendNotification called on disposed client", { method });
      return;
    }

    const message = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.stdin.write(message);
  }

  /**
   * Disposes the client by rejecting all pending requests and removing stream listeners.
   * After disposal, calling `sendRequest` throws immediately.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.stdout.off("data", this.onData);
    this.stdout.off("close", this.onClose);
    this.stdout.off("end", this.onClose);
    this.stdout.off("error", this.onError);

    this.rejectAll(new Error("RPC client disposed"));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Parses and dispatches a single NDJSON line received from stdout. */
  private processLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger.warn("CodexRpcClient: malformed JSON line", { line: trimmed });
      return;
    }

    const hasId = typeof msg["id"] === "number";
    const hasMethod = typeof msg["method"] === "string";

    if (hasId && !hasMethod) {
      // Response to one of our requests
      const id = msg["id"] as number;
      const entry = this.pending.get(id);
      if (!entry) {
        logger.warn("CodexRpcClient: received response for unknown id", { id });
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(id);

      const error = msg["error"] as { message?: string } | undefined;
      if (error) {
        entry.reject(new Error(error.message ?? "RPC error"));
      } else {
        entry.resolve(msg["result"]);
      }
      return;
    }

    if (hasId && hasMethod) {
      // Server-initiated request (e.g. approval prompt)
      this.emit("serverRequest", msg);
      return;
    }

    if (hasMethod && !hasId) {
      // Server notification
      this.emit("notification", msg);
      return;
    }

    logger.warn("CodexRpcClient: unrecognized message", { msg });
  }

  /** Rejects all pending requests with the given error and clears the map. */
  private rejectAll(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }
}
