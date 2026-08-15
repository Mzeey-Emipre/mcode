import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Socket mock factory - create a fresh mock per test via beforeEach
// ---------------------------------------------------------------------------

let mockSocket: {
  on: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

/** Per-test handler registry, keyed by event name. */
let handlers: Record<string, (...args: unknown[]) => void>;

vi.mock("net", () => ({
  connect: vi.fn(),
}));

import { startIpcRelay } from "../ipc-relay.js";
import { connect as netConnect } from "net";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal window stub that satisfies the RelayWindow contract. */
function makeWindow(destroyed = false, webContentsDestroyed = false) {
  return {
    isDestroyed: vi.fn().mockReturnValue(destroyed),
    webContents: {
      isDestroyed: vi.fn().mockReturnValue(webContentsDestroyed),
      send: vi.fn(),
    },
  };
}

/**
 * Build a length-prefixed frame buffer for a single JSON message.
 * Wire format: 4-byte big-endian length (UTF-8 byte count) followed by the UTF-8 JSON body.
 */
function encodeFrame(data: unknown): Buffer {
  const json = JSON.stringify(data);
  const body = Buffer.from(json, "utf-8");
  const buf = Buffer.alloc(4 + body.length);
  buf.writeUInt32BE(body.length, 0);
  body.copy(buf, 4);
  return buf;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  handlers = {};
  mockSocket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
      return mockSocket;
    }),
    destroy: vi.fn(),
  };
  vi.mocked(netConnect).mockReturnValue(mockSocket as unknown as ReturnType<typeof netConnect>);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startIpcRelay", () => {
  describe("empty ipcPath", () => {
    it("returns a no-op cleanup without connecting", () => {
      const cleanup = startIpcRelay("", makeWindow() as never);

      cleanup(); // must not throw

      expect(netConnect).not.toHaveBeenCalled();
    });
  });

  describe("socket lifecycle", () => {
    it("connects to the given ipcPath", () => {
      startIpcRelay("/tmp/mcode.sock", makeWindow() as never);

      expect(netConnect).toHaveBeenCalledWith("/tmp/mcode.sock");
    });

    it("cleanup destroys the socket", () => {
      const cleanup = startIpcRelay("/tmp/mcode.sock", makeWindow() as never);

      cleanup();

      expect(mockSocket.destroy).toHaveBeenCalledOnce();
    });

    it("destroys socket on error event", () => {
      startIpcRelay("/tmp/mcode.sock", makeWindow() as never);

      handlers["error"]?.(new Error("ECONNREFUSED"));

      expect(mockSocket.destroy).toHaveBeenCalledOnce();
    });

    it("sends ipc-push-disconnect on close when window is alive", () => {
      const win = makeWindow(false);
      startIpcRelay("/tmp/mcode.sock", win as never);

      handlers["close"]?.();

      expect(win.webContents.send).toHaveBeenCalledWith("ipc-push-disconnect");
    });

    it("skips ipc-push-disconnect when window is destroyed", () => {
      const win = makeWindow(true);
      startIpcRelay("/tmp/mcode.sock", win as never);

      handlers["close"]?.();

      expect(win.webContents.send).not.toHaveBeenCalled();
    });

    it("skips ipc-push-disconnect when webContents is destroyed but window is alive", () => {
      const win = makeWindow(false, true);
      startIpcRelay("/tmp/mcode.sock", win as never);

      handlers["close"]?.();

      expect(win.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe("frame parsing", () => {
    it("forwards a single complete frame to the renderer", () => {
      const win = makeWindow(false);
      startIpcRelay("/tmp/mcode.sock", win as never);

      const message = { type: "test-event", payload: 42 };
      handlers["data"]?.(encodeFrame(message));

      expect(win.webContents.send).toHaveBeenCalledWith("ipc-push-message", message);
    });

    it("forwards multiple frames from a single data chunk", () => {
      const win = makeWindow(false);
      startIpcRelay("/tmp/mcode.sock", win as never);

      const a = { id: 1 };
      const b = { id: 2 };
      const combined = Buffer.concat([encodeFrame(a), encodeFrame(b)]);

      handlers["data"]?.(combined);

      expect(win.webContents.send).toHaveBeenCalledTimes(2);
      expect(win.webContents.send).toHaveBeenNthCalledWith(1, "ipc-push-message", a);
      expect(win.webContents.send).toHaveBeenNthCalledWith(2, "ipc-push-message", b);
    });

    it("buffers a partial frame and flushes on the next data event", () => {
      const win = makeWindow(false);
      startIpcRelay("/tmp/mcode.sock", win as never);

      const message = { hello: "world" };
      const full = encodeFrame(message);
      const firstHalf = full.subarray(0, Math.floor(full.length / 2));
      const secondHalf = full.subarray(Math.floor(full.length / 2));

      handlers["data"]?.(firstHalf);
      expect(win.webContents.send).not.toHaveBeenCalled();

      handlers["data"]?.(secondHalf);
      expect(win.webContents.send).toHaveBeenCalledWith("ipc-push-message", message);
    });

    it("skips malformed JSON frames without throwing", () => {
      const win = makeWindow(false);
      startIpcRelay("/tmp/mcode.sock", win as never);

      const garbage = Buffer.from("not-json");
      const buf = Buffer.alloc(4 + garbage.length);
      buf.writeUInt32BE(garbage.length, 0);
      garbage.copy(buf, 4);

      expect(() => handlers["data"]?.(buf)).not.toThrow();
      expect(win.webContents.send).not.toHaveBeenCalled();
    });

    it("does not forward frames to a destroyed window", () => {
      const win = makeWindow(true);
      startIpcRelay("/tmp/mcode.sock", win as never);

      handlers["data"]?.(encodeFrame({ event: "ping" }));

      expect(win.webContents.send).not.toHaveBeenCalled();
    });

    it("does not forward frames when webContents is destroyed but window is alive", () => {
      const win = makeWindow(false, true);
      startIpcRelay("/tmp/mcode.sock", win as never);

      handlers["data"]?.(encodeFrame({ event: "ping" }));

      expect(win.webContents.send).not.toHaveBeenCalled();
    });

    it("destroys socket when frame length exceeds MAX_FRAME_SIZE", () => {
      startIpcRelay("/tmp/mcode.sock", makeWindow() as never);

      // Write a length prefix of 9 MiB, which exceeds the 8 MiB limit.
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(9 * 1024 * 1024, 0);

      handlers["data"]?.(buf);

      expect(mockSocket.destroy).toHaveBeenCalled();
    });

    it("encodes and decodes non-ASCII payloads correctly", () => {
      const win = makeWindow(false);
      startIpcRelay("/tmp/mcode.sock", win as never);

      const message = { text: "こんにちは 🌍" };
      handlers["data"]?.(encodeFrame(message));

      expect(win.webContents.send).toHaveBeenCalledWith("ipc-push-message", message);
    });
  });
});
