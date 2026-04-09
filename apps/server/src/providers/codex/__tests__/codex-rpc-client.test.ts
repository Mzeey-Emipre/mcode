import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "stream";

vi.mock("@mcode/shared", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { CodexRpcClient } from "../codex-rpc-client.js";

/** Creates a fresh pair of PassThrough streams and a CodexRpcClient for each test. */
function makeClient() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexRpcClient(stdin, stdout);
  return { stdin, stdout, client };
}

describe("CodexRpcClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with correct result on successful response", async () => {
    const { stdout, client } = makeClient();

    const promise = client.sendRequest("initialize", { foo: "bar" });

    stdout.push('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("rejects with timeout error when no response arrives", async () => {
    vi.useFakeTimers();

    const { client } = makeClient();

    const promise = client.sendRequest("initialize", {}, 50);

    vi.advanceTimersByTime(100);

    await expect(promise).rejects.toThrow("Timed out waiting for initialize (50ms)");
  });

  it("dispatches notification event for inbound notifications", async () => {
    const { stdout, client } = makeClient();

    const handler = vi.fn();
    client.on("notification", handler);

    stdout.push(
      '{"jsonrpc":"2.0","method":"turn.event","params":{"type":"agent_message","text":"hello"}}\n',
    );

    // Allow microtasks / stream data events to flush
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(handler).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      method: "turn.event",
      params: { type: "agent_message", text: "hello" },
    });
  });

  it("buffers partial lines correctly", async () => {
    const { stdout, client } = makeClient();

    const promise = client.sendRequest("initialize", {});

    // Write the first chunk - ends mid-key, no newline yet
    stdout.push('{"jsonrpc":"2.0","id":1,"resul');

    // Give the stream a chance to emit data events
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The promise should still be pending (no newline seen yet)
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);

    // Write the rest of the line with newline
    stdout.push('t":{"ok":true}}\n');

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("handles multiple concurrent requests and correlates by id", async () => {
    const { stdout, client } = makeClient();

    const p1 = client.sendRequest("method1", {});
    const p2 = client.sendRequest("method2", {});
    const p3 = client.sendRequest("method3", {});

    // Respond out of order: id 3, then id 1, then id 2
    stdout.push('{"jsonrpc":"2.0","id":3,"result":{"from":"method3"}}\n');
    stdout.push('{"jsonrpc":"2.0","id":1,"result":{"from":"method1"}}\n');
    stdout.push('{"jsonrpc":"2.0","id":2,"result":{"from":"method2"}}\n');

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toEqual({ from: "method1" });
    expect(r2).toEqual({ from: "method2" });
    expect(r3).toEqual({ from: "method3" });
  });

  it("dispose rejects all pending requests", async () => {
    const { client } = makeClient();

    const p1 = client.sendRequest("method1", {});
    const p2 = client.sendRequest("method2", {});

    client.dispose();

    await expect(p1).rejects.toThrow("RPC client disposed");
    await expect(p2).rejects.toThrow("RPC client disposed");
  });

  it("sendRequest after dispose rejects immediately", async () => {
    const { client } = makeClient();

    client.dispose();

    await expect(client.sendRequest("initialize", {})).rejects.toThrow("RPC client is disposed");
  });

  it("skips malformed JSON lines without crashing", async () => {
    const { stdout, client } = makeClient();

    const promise = client.sendRequest("initialize", {});

    // Send a malformed line first
    stdout.push("not-json\n");

    // Then send the valid response
    stdout.push('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("rejects pending requests when stdout stream closes", async () => {
    const { stdout, client } = makeClient();

    const promise = client.sendRequest("initialize", {});

    stdout.emit("close");

    await expect(promise).rejects.toThrow("Stream closed");
  });
});
