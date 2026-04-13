import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConnection } from "net";
import { IpcPushServer } from "../transport/ipc-push-server";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

function ipcPath(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\mcode-test-${randomUUID()}`
    : join(tmpdir(), `mcode-test-${randomUUID()}.sock`);
}

/** Read a length-prefixed frame from a buffer. */
function readFrame(buf: Buffer): unknown {
  const len = buf.readUInt32BE(0);
  const json = buf.subarray(4, 4 + len).toString("utf-8");
  return JSON.parse(json);
}

describe("IpcPushServer", () => {
  let server: IpcPushServer;
  let path: string;

  beforeEach(() => {
    path = ipcPath();
    server = new IpcPushServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("starts listening on the given path", async () => {
    await server.listen(path);
    expect(server.isListening).toBe(true);
  });

  it("accepts a connection and returns a MessagePortLike", async () => {
    const onAttach = vi.fn();
    server.onConnection(onAttach);
    await server.listen(path);

    const client = createConnection(path);
    await new Promise<void>((r) => client.on("connect", r));
    await new Promise((r) => setTimeout(r, 50));
    expect(onAttach).toHaveBeenCalledTimes(1);

    const portLike = onAttach.mock.calls[0][0];
    expect(portLike).toHaveProperty("postMessage");
    expect(portLike).toHaveProperty("close");
    expect(portLike).toHaveProperty("on");

    client.destroy();
  });

  it("sends length-prefixed JSON frames via postMessage", async () => {
    const onAttach = vi.fn();
    server.onConnection(onAttach);
    await server.listen(path);

    const client = createConnection(path);
    await new Promise<void>((r) => client.on("connect", r));
    await new Promise((r) => setTimeout(r, 50));

    const portLike = onAttach.mock.calls[0][0];
    portLike.postMessage({ channel: "terminal.data", data: { id: "1", output: "hello" } });

    const chunks: Buffer[] = [];
    client.on("data", (chunk) => chunks.push(chunk));
    await new Promise((r) => setTimeout(r, 100));

    const buf = Buffer.concat(chunks);
    const frame = readFrame(buf);
    expect(frame).toEqual({ channel: "terminal.data", data: { id: "1", output: "hello" } });

    client.destroy();
  });

  it("close() shuts down the server", async () => {
    await server.listen(path);
    await server.close();
    expect(server.isListening).toBe(false);
  });
});
