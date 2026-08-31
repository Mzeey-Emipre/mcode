import * as NodeBuffer from "node:buffer";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import {
  PTY_HOST_MAX_MESSAGE_BYTES,
  PTY_HOST_MAX_RETAINED_RECORDS,
  PtyHostEventSchema,
  type PtyHostEvent,
} from "./pty-host-protocol.js";
import { PtyHostProcessRuntime } from "./pty-host-runtime.js";
import { terminalPlatform } from "../terminal-platform.js";

const MAX_IPC_QUEUE_BYTES = 1_048_576;

/** Bounded serial queue for untrusted server-to-host IPC messages. */
export class PtyHostMessageQueue {
  private tail = Promise.resolve();
  private records = 0;
  private bytes = 0;
  private failed = false;

  constructor(
    private readonly handle: (message: unknown) => Promise<void>,
    private readonly handleError: (error: unknown) => Promise<void>,
  ) {}

  /** Returns the bytes retained by messages that have not completed. */
  get pendingBytes(): number {
    return this.bytes;
  }

  /** Enqueues one message or returns false when the bounded queue is full. */
  enqueue(message: unknown): boolean {
    const serialized = JSON.stringify(message);
    if (serialized === undefined) {
      throw new Error("PTY host IPC message is not serializable");
    }
    const messageBytes = NodeBuffer.Buffer.byteLength(serialized, "utf8");
    if (
      messageBytes > PTY_HOST_MAX_MESSAGE_BYTES ||
      this.records >= PTY_HOST_MAX_RETAINED_RECORDS ||
      this.bytes + messageBytes > MAX_IPC_QUEUE_BYTES
    ) {
      return false;
    }
    this.records += 1;
    this.bytes += messageBytes;
    this.tail = this.tail
      .then(async () => {
        if (!this.failed) await this.handle(message);
      })
      .catch(async (error: unknown) => {
        if (this.failed) return;
        this.failed = true;
        await this.handleError(error);
      })
      .finally(() => {
        this.records -= 1;
        this.bytes -= messageBytes;
      });
    return true;
  }

  /** Resolves after all retained messages finish or are discarded. */
  idle(): Promise<void> {
    return this.tail;
  }
}

/** Starts the isolated PTY host message loop in the current Node process. */
export function runPtyHostProcess(hostRuntime: HostRuntime): PtyHostProcessRuntime {
  if (typeof process.send !== "function") {
    throw new Error("PTY host requires an inherited IPC channel");
  }
  let outboundBytes = 0;
  let queue: PtyHostMessageQueue | undefined;
  let runtime: PtyHostProcessRuntime;
  let failing = false;
  const failHost = async (error: unknown): Promise<void> => {
    if (failing) return;
    failing = true;
    process.stderr.write(
      `[pty-host] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    await runtime.dispose();
    process.exitCode = 1;
    process.disconnect?.();
  };
  const publish = (event: PtyHostEvent): void => {
    const validated = PtyHostEventSchema().parse(event);
    if (!process.connected || !process.send) {
      throw new Error("PTY host IPC channel is unavailable");
    }
    const eventBytes = NodeBuffer.Buffer.byteLength(JSON.stringify(validated), "utf8");
    if (outboundBytes + eventBytes > MAX_IPC_QUEUE_BYTES) {
      throw new Error("PTY host event queue exceeds 1 MiB");
    }
    outboundBytes += eventBytes;
    process.send(validated, (error) => {
      outboundBytes = Math.max(0, outboundBytes - eventBytes);
      if (error) void failHost(error);
    });
  };
  runtime = new PtyHostProcessRuntime({
    platform: terminalPlatform(hostRuntime.platform),
    hostRuntime,
    nativeAbi: `${hostRuntime.platform}-${hostRuntime.architecture}-${hostRuntime.nodeAbi}`,
    publish,
    queueBytes: () =>
      Math.min(MAX_IPC_QUEUE_BYTES, (queue?.pendingBytes ?? 0) + outboundBytes),
  });
  queue = new PtyHostMessageQueue(async (message) => {
    await runtime.receive(message);
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { kind?: unknown }).kind === "shutdown"
    ) {
      process.disconnect?.();
    }
  }, failHost);
  process.on("message", (message: unknown) => {
    try {
      if (!queue?.enqueue(message)) {
        void failHost(new Error("PTY host IPC queue limit reached"));
      }
    } catch (error) {
      void failHost(error);
    }
  });
  process.once("disconnect", () => {
    void queue?.idle().finally(async () => {
      await runtime.dispose();
      process.exitCode ??= 0;
    });
  });
  return runtime;
}
