import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let onDataCallback: ((data: string) => void) | null = null;
let onExitCallback: ((e: { exitCode: number; signal?: number }) => void) | null = null;

function createMockPty() {
  return {
    pid: Math.floor(Math.random() * 10000),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => {
      onDataCallback = cb;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
      onExitCallback = cb;
      return { dispose: vi.fn() };
    }),
  };
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => createMockPty()),
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-uuid"),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

vi.mock("path", () => ({
  isAbsolute: vi.fn((p: string) => p.startsWith("/")),
}));

import { PtyManager } from "../pty-manager.js";
import { spawn as ptySpawn } from "node-pty";
import { v4 as uuid } from "uuid";
import { existsSync, statSync } from "fs";
import { isAbsolute } from "path";

describe("PtyManager", () => {
  let manager: PtyManager;
  let uuidCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    onDataCallback = null;
    onExitCallback = null;
    uuidCounter = 0;
    vi.mocked(uuid).mockImplementation(() => `pty-${++uuidCounter}`);
    manager = new PtyManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe("create", () => {
    it("spawns a PTY and returns a session ID", () => {
      const id = manager.create("thread-1", "/tmp");
      expect(id).toBe("pty-1");
      expect(ptySpawn).toHaveBeenCalledTimes(1);
    });

    it("passes cwd and default cols/rows to spawn", () => {
      manager.create("thread-1", "/home/user");
      const call = vi.mocked(ptySpawn).mock.calls[0];
      const opts = call[2] as Record<string, unknown>;
      expect(opts.cwd).toBe("/home/user");
      expect(opts.cols).toBe(80);
      expect(opts.rows).toBe(24);
      expect(opts.name).toBe("xterm-256color");
    });

    it("allows up to 4 PTYs per thread", () => {
      manager.create("thread-1", "/tmp");
      manager.create("thread-1", "/tmp");
      manager.create("thread-1", "/tmp");
      manager.create("thread-1", "/tmp");
      expect(ptySpawn).toHaveBeenCalledTimes(4);
    });

    it("throws when exceeding 4 PTYs per thread", () => {
      manager.create("thread-1", "/tmp");
      manager.create("thread-1", "/tmp");
      manager.create("thread-1", "/tmp");
      manager.create("thread-1", "/tmp");
      expect(() => manager.create("thread-1", "/tmp")).toThrow(
        "Maximum PTY limit (4) reached for thread thread-1",
      );
    });

    it("counts PTYs per thread independently", () => {
      manager.create("thread-1", "/tmp");
      manager.create("thread-1", "/tmp");
      manager.create("thread-1", "/tmp");
      manager.create("thread-1", "/tmp");
      // different thread should still work
      const id = manager.create("thread-2", "/tmp");
      expect(id).toBe("pty-5");
    });

    it("throws for a relative cwd path", () => {
      vi.mocked(isAbsolute).mockReturnValueOnce(false);
      expect(() => manager.create("thread-1", "relative/path")).toThrow(
        "Invalid working directory: relative/path",
      );
      expect(ptySpawn).not.toHaveBeenCalled();
    });

    it("throws when cwd does not exist", () => {
      vi.mocked(existsSync).mockReturnValueOnce(false);
      expect(() => manager.create("thread-1", "/nonexistent")).toThrow(
        "Invalid working directory: /nonexistent",
      );
      expect(ptySpawn).not.toHaveBeenCalled();
    });

    it("throws when cwd is a file, not a directory", () => {
      vi.mocked(statSync).mockReturnValueOnce({
        isDirectory: () => false,
      } as ReturnType<typeof statSync>);
      expect(() => manager.create("thread-1", "/tmp/somefile.txt")).toThrow(
        "Invalid working directory: /tmp/somefile.txt",
      );
      expect(ptySpawn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // write
  // -------------------------------------------------------------------------

  describe("write", () => {
    it("forwards data to the PTY process", () => {
      const id = manager.create("thread-1", "/tmp");
      const mockPty = vi.mocked(ptySpawn).mock.results[0].value;
      manager.write(id, "ls -la\r");
      expect(mockPty.write).toHaveBeenCalledWith("ls -la\r");
    });

    it("throws for unknown PTY id", () => {
      expect(() => manager.write("nonexistent", "data")).toThrow(
        "PTY not found: nonexistent",
      );
    });
  });

  // -------------------------------------------------------------------------
  // resize
  // -------------------------------------------------------------------------

  describe("resize", () => {
    it("resizes the PTY process", () => {
      const id = manager.create("thread-1", "/tmp");
      const mockPty = vi.mocked(ptySpawn).mock.results[0].value;
      manager.resize(id, 120, 40);
      expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
    });

    it("throws for unknown PTY id", () => {
      expect(() => manager.resize("nonexistent", 80, 24)).toThrow(
        "PTY not found: nonexistent",
      );
    });
  });

  // -------------------------------------------------------------------------
  // kill
  // -------------------------------------------------------------------------

  describe("kill", () => {
    it("kills a single PTY and removes it from tracking", () => {
      const id = manager.create("thread-1", "/tmp");
      const mockPty = vi.mocked(ptySpawn).mock.results[0].value;
      const dataDisposable = mockPty.onData.mock.results[0].value;
      const exitDisposable = mockPty.onExit.mock.results[0].value;
      manager.kill(id);
      expect(dataDisposable.dispose).toHaveBeenCalled();
      expect(exitDisposable.dispose).toHaveBeenCalled();
      expect(mockPty.kill).toHaveBeenCalled();
      // Writing after kill should throw
      expect(() => manager.write(id, "data")).toThrow("PTY not found");
    });

    it("is a no-op for unknown PTY id", () => {
      expect(() => manager.kill("nonexistent")).not.toThrow();
    });

    it("frees a slot so a new PTY can be created for the same thread", () => {
      manager.create("thread-1", "/tmp");
      manager.create("thread-1", "/tmp");
      manager.create("thread-1", "/tmp");
      const id4 = manager.create("thread-1", "/tmp");
      // at limit
      expect(() => manager.create("thread-1", "/tmp")).toThrow();
      manager.kill(id4);
      // now one slot is free
      expect(() => manager.create("thread-1", "/tmp")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // killByThread
  // -------------------------------------------------------------------------

  describe("killByThread", () => {
    it("kills all PTYs for a given thread", () => {
      manager.create("thread-1", "/tmp");
      manager.create("thread-1", "/tmp");
      manager.create("thread-2", "/tmp");

      manager.killByThread("thread-1");

      // All thread-1 PTYs should be killed
      const results = vi.mocked(ptySpawn).mock.results;
      expect(results[0].value.kill).toHaveBeenCalled();
      expect(results[1].value.kill).toHaveBeenCalled();
      // thread-2 PTY should not be killed
      expect(results[2].value.kill).not.toHaveBeenCalled();
    });

    it("is a no-op for unknown thread", () => {
      expect(() => manager.killByThread("nonexistent")).not.toThrow();
    });

    it("allows creating new PTYs for the thread after killByThread", () => {
      manager.create("thread-1", "/tmp");
      manager.create("thread-1", "/tmp");
      manager.killByThread("thread-1");
      expect(() => manager.create("thread-1", "/tmp")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // shutdown
  // -------------------------------------------------------------------------

  describe("shutdown", () => {
    it("kills all PTYs across all threads", () => {
      manager.create("thread-1", "/tmp");
      manager.create("thread-2", "/tmp");
      manager.create("thread-3", "/tmp");

      manager.shutdown();

      const results = vi.mocked(ptySpawn).mock.results;
      for (const result of results) {
        expect(result.value.kill).toHaveBeenCalled();
      }
    });

    it("clears internal state after shutdown", () => {
      manager.create("thread-1", "/tmp");
      manager.shutdown();
      // Should be able to create again (fresh state)
      expect(() => manager.create("thread-1", "/tmp")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // setSender + streaming events
  // -------------------------------------------------------------------------

  describe("setSender / streaming", () => {
    it("streams pty:data events via sender", () => {
      const sender = vi.fn();
      manager.setSender(sender);

      manager.create("thread-1", "/tmp");

      // Simulate data event from the PTY
      expect(onDataCallback).toBeDefined();
      onDataCallback!("hello world");

      expect(sender).toHaveBeenCalledWith("pty:data", {
        ptyId: "pty-1",
        data: "hello world",
      });
    });

    it("streams pty:exit events via sender", () => {
      const sender = vi.fn();
      manager.setSender(sender);

      manager.create("thread-1", "/tmp");

      // Simulate exit event
      expect(onExitCallback).toBeDefined();
      onExitCallback!({ exitCode: 0 });

      expect(sender).toHaveBeenCalledWith("pty:exit", {
        ptyId: "pty-1",
        exitCode: 0,
      });
    });

    it("does not throw when no sender is set", () => {
      manager.create("thread-1", "/tmp");

      expect(onDataCallback).toBeDefined();
      // Should not throw even without a sender
      expect(() => onDataCallback!("some data")).not.toThrow();
    });
  });
});
