import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { tmpdir } from "os";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers/db.js";
import * as WorkspaceRepo from "../repositories/workspace-repo.js";
import * as ThreadRepo from "../repositories/thread-repo.js";
import * as MessageRepo from "../repositories/message-repo.js";

// Mock worktree module
vi.mock("../worktree.js", () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  listWorktrees: vi.fn().mockReturnValue([]),
  listBranches: vi.fn().mockReturnValue([]),
  getCurrentBranch: vi.fn().mockReturnValue("main"),
  checkoutBranch: vi.fn(),
}));

// Mock sidecar client module
vi.mock("../sidecar/client.js", () => ({
  SidecarClient: {
    start: vi.fn().mockReturnValue({
      sendMessage: vi.fn(),
      stopSession: vi.fn(),
      shutdown: vi.fn(),
      on: vi.fn(),
      isReady: vi.fn().mockReturnValue(true),
    }),
  },
}));

// Mock logger to suppress output
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Use vi.hoisted to create a container accessible inside the hoisted vi.mock factory.
// This stores references to the real fs functions so tests can restore delegation.
const fsRefs = vi.hoisted(() => ({
  realExistsSync: null as null | (typeof import("fs"))["existsSync"],
  realStatSync: null as null | (typeof import("fs"))["statSync"],
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  fsRefs.realExistsSync = actual.existsSync;
  fsRefs.realStatSync = actual.statSync;
  return {
    ...actual,
    existsSync: vi.fn((...args: Parameters<typeof actual.existsSync>) =>
      actual.existsSync(...args),
    ),
    statSync: vi.fn((...args: Parameters<typeof actual.statSync>) =>
      actual.statSync(...args),
    ),
  };
});

import { AppState } from "../app-state.js";
import { createWorktree, removeWorktree } from "../worktree.js";
import { existsSync, statSync } from "fs";

/**
 * Helper: build an AppState instance backed by an in-memory DB.
 * Bypasses the constructor (which opens a file-based DB) by using
 * Object.create, then wires up the three internal fields directly.
 */
function buildAppState(db: Database.Database): AppState {
  const appState = Object.create(AppState.prototype) as AppState;
  (appState as unknown as { db: Database.Database }).db = db;
  (appState as unknown as { sidecar: null }).sidecar = null;
  (appState as unknown as { activeSessionIds: Set<string> }).activeSessionIds =
    new Set();
  return appState;
}

/** Attach a mock sidecar to the AppState. Returns the mock object. */
function attachMockSidecar(appState: AppState) {
  const mockSidecar = {
    sendMessage: vi.fn(),
    stopSession: vi.fn(),
    shutdown: vi.fn(),
    on: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
  };
  (appState as unknown as { sidecar: typeof mockSidecar }).sidecar =
    mockSidecar;
  return mockSidecar;
}

/** Reset fs mocks to delegate to real implementations. */
function resetFsMocks(): void {
  vi.mocked(existsSync).mockImplementation(
    (...args: Parameters<typeof existsSync>) => fsRefs.realExistsSync!(...args),
  );
  vi.mocked(statSync).mockImplementation(
    (...args: Parameters<typeof statSync>) =>
      fsRefs.realStatSync!(...(args as [string])) as ReturnType<typeof statSync>,
  );
}

describe("AppState", () => {
  let appState: AppState;
  let db: Database.Database;

  beforeEach(() => {
    vi.resetAllMocks();
    db = createTestDb();
    appState = buildAppState(db);
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  // -------------------------------------------------------------------------
  // createThread
  // -------------------------------------------------------------------------
  describe("createThread", () => {
    let workspaceId: string;

    beforeEach(() => {
      const ws = WorkspaceRepo.create(db, "proj", "/tmp/proj");
      workspaceId = ws.id;
    });

    it("direct mode creates thread without calling createWorktree", () => {
      const thread = appState.createThread(
        workspaceId,
        "Feature",
        "direct",
        "main",
      );
      expect(thread.mode).toBe("direct");
      expect(thread.worktree_path).toBeNull();
      expect(createWorktree).not.toHaveBeenCalled();
    });

    it("worktree mode calls createWorktree and persists worktree_path", () => {
      vi.mocked(createWorktree).mockReturnValue({
        name: "feature-12345678",
        path: "/tmp/wt/feature-12345678",
        branch: "mcode/feature-12345678",
        managed: true,
      });
      const thread = appState.createThread(
        workspaceId,
        "Feature",
        "worktree",
        "main",
      );
      expect(createWorktree).toHaveBeenCalled();
      expect(thread.worktree_path).toBe("/tmp/wt/feature-12345678");
    });

    it("worktree failure: DB record is hard-deleted on createWorktree throw", () => {
      vi.mocked(createWorktree).mockImplementation(() => {
        throw new Error("git worktree add failed");
      });
      expect(() =>
        appState.createThread(workspaceId, "Feature", "worktree", "main"),
      ).toThrow("git worktree add failed");
      // Verify the thread was cleaned up
      const threads = ThreadRepo.listByWorkspace(db, workspaceId);
      expect(threads).toHaveLength(0);
    });

    it("worktree mode with nonexistent workspace: hard-deletes DB record", () => {
      expect(() =>
        appState.createThread(
          "nonexistent-ws-id",
          "Feature",
          "worktree",
          "main",
        ),
      ).toThrow();
      // Verify the thread was rolled back from the DB
      const allThreads = db.prepare("SELECT * FROM threads").all();
      expect(allThreads).toHaveLength(0);
    });

    it("rejects empty branch name", () => {
      expect(() =>
        appState.createThread(workspaceId, "F", "direct", ""),
      ).toThrow("Branch name must be 1-250 characters");
    });

    it("rejects branch >250 chars", () => {
      expect(() =>
        appState.createThread(workspaceId, "F", "direct", "a".repeat(251)),
      ).toThrow("Branch name must be 1-250 characters");
    });

    it.each([
      "feat~1",
      "feat^2",
      "feat:bar",
      "feat?",
      "feat*",
      "feat[0]",
      "feat\\bar",
      "feat\tbar",
      "feat..bar",
      "-leading",
      "feat bar",
    ])("rejects invalid branch chars: %s", (branch) => {
      expect(() =>
        appState.createThread(workspaceId, "F", "direct", branch),
      ).toThrow("Branch name contains invalid characters");
    });

    it("rejects unknown mode", () => {
      expect(() =>
        appState.createThread(
          workspaceId,
          "F",
          "unknown" as string,
          "main",
        ),
      ).toThrow("Unknown thread mode: unknown");
    });
  });

  // -------------------------------------------------------------------------
  // sendMessage
  // -------------------------------------------------------------------------
  describe("sendMessage", () => {
    let workspaceId: string;
    let threadId: string;

    beforeEach(() => {
      // Use a real temp directory so cwd validation passes
      const realDir = tmpdir();
      const ws = WorkspaceRepo.create(db, "proj", realDir);
      workspaceId = ws.id;
      const thread = ThreadRepo.create(
        db,
        workspaceId,
        "Test Thread",
        "direct",
        "main",
      );
      threadId = thread.id;

      // Reset fs mocks to delegate to real implementations
      resetFsMocks();
    });

    it("happy path: persists user message, sets status active, calls sidecar", async () => {
      const mockSidecar = attachMockSidecar(appState);

      await appState.sendMessage(threadId, "Hello agent", "default");

      // User message persisted
      const msgs = MessageRepo.listByThread(db, threadId, 100);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe("user");
      expect(msgs[0].content).toBe("Hello agent");
      expect(msgs[0].sequence).toBe(1);

      // Thread status set to active
      const thread = ThreadRepo.findById(db, threadId);
      expect(thread?.status).toBe("active");

      // Model persisted
      expect(thread?.model).toBe("claude-sonnet-4-6");

      // Sidecar called with correct args
      expect(mockSidecar.sendMessage).toHaveBeenCalledWith(
        `mcode-${threadId}`,
        "Hello agent",
        expect.any(String), // cwd
        "claude-sonnet-4-6",
        false, // isResume = false (first message)
        "default",
      );
    });

    it("throws when thread does not exist", async () => {
      attachMockSidecar(appState);
      await expect(
        appState.sendMessage("nonexistent", "hi", "default"),
      ).rejects.toThrow("Thread not found: nonexistent");
    });

    it("throws when thread is deleted", async () => {
      attachMockSidecar(appState);
      ThreadRepo.softDelete(db, threadId);
      await expect(
        appState.sendMessage(threadId, "hi", "default"),
      ).rejects.toThrow("Cannot send message to deleted thread");
    });

    it("throws when sidecar is not started", async () => {
      // sidecar is null by default
      await expect(
        appState.sendMessage(threadId, "hi", "default"),
      ).rejects.toThrow("Sidecar not started");

      // Status should be reverted to paused
      const thread = ThreadRepo.findById(db, threadId);
      expect(thread?.status).toBe("paused");
    });

    it("resume detection: isResume=true when existing messages present", async () => {
      const mockSidecar = attachMockSidecar(appState);

      // Insert a prior message so nextSeq > 1
      MessageRepo.create(db, threadId, "user", "First message", 1);

      await appState.sendMessage(threadId, "Follow-up", "default");

      // Second message should be sequence 2
      const msgs = MessageRepo.listByThread(db, threadId, 100);
      expect(msgs).toHaveLength(2);
      expect(msgs[1].sequence).toBe(2);

      // Sidecar called with resume=true
      expect(mockSidecar.sendMessage).toHaveBeenCalledWith(
        `mcode-${threadId}`,
        "Follow-up",
        expect.any(String),
        "claude-sonnet-4-6",
        true, // isResume = true
        "default",
      );
    });

    it("rollback on sidecar send failure: status reverts to paused", async () => {
      const mockSidecar = attachMockSidecar(appState);
      mockSidecar.sendMessage.mockImplementation(() => {
        throw new Error("sidecar crash");
      });

      await expect(
        appState.sendMessage(threadId, "hi", "default"),
      ).rejects.toThrow("sidecar crash");

      const thread = ThreadRepo.findById(db, threadId);
      expect(thread?.status).toBe("paused");
    });

    it("rejects invalid cwd (nonexistent directory)", async () => {
      attachMockSidecar(appState);

      // Create workspace with a path that does not exist
      const ws2 = WorkspaceRepo.create(
        db,
        "ghost",
        "/nonexistent/path/that/does/not/exist",
      );
      const t2 = ThreadRepo.create(
        db,
        ws2.id,
        "Thread",
        "direct",
        "main",
      );

      await expect(
        appState.sendMessage(t2.id, "hi", "default"),
      ).rejects.toThrow("cwd is not a valid absolute directory");

      // Status reverted to paused
      const thread = ThreadRepo.findById(db, t2.id);
      expect(thread?.status).toBe("paused");
    });

    it("uses custom model when provided", async () => {
      const mockSidecar = attachMockSidecar(appState);

      await appState.sendMessage(threadId, "hi", "default", "claude-opus-4-6");

      expect(mockSidecar.sendMessage).toHaveBeenCalledWith(
        expect.any(String),
        "hi",
        expect.any(String),
        "claude-opus-4-6",
        false,
        "default",
      );

      const thread = ThreadRepo.findById(db, threadId);
      expect(thread?.model).toBe("claude-opus-4-6");
    });

    it("worktree thread uses worktree_path as cwd", async () => {
      const mockSidecar = attachMockSidecar(appState);

      // Create a worktree-mode thread with a real temp dir as worktree_path
      const realDir = tmpdir();
      const t = ThreadRepo.create(
        db,
        workspaceId,
        "WT Thread",
        "worktree",
        "main",
      );
      ThreadRepo.updateWorktreePath(db, t.id, realDir);

      await appState.sendMessage(t.id, "hi", "default");

      expect(mockSidecar.sendMessage).toHaveBeenCalledWith(
        `mcode-${t.id}`,
        "hi",
        realDir,
        "claude-sonnet-4-6",
        false,
        "default",
      );
    });

    it("worktree thread without worktree_path throws", async () => {
      attachMockSidecar(appState);

      const t = ThreadRepo.create(
        db,
        workspaceId,
        "WT Thread",
        "worktree",
        "main",
      );
      // worktree_path is null by default

      await expect(
        appState.sendMessage(t.id, "hi", "default"),
      ).rejects.toThrow("has no worktree_path set");
    });
  });

  // -------------------------------------------------------------------------
  // stopAgent
  // -------------------------------------------------------------------------
  describe("stopAgent", () => {
    let workspaceId: string;
    let threadId: string;

    beforeEach(() => {
      const ws = WorkspaceRepo.create(db, "proj", "/tmp/proj");
      workspaceId = ws.id;
      const thread = ThreadRepo.create(
        db,
        workspaceId,
        "Test",
        "direct",
        "main",
      );
      threadId = thread.id;
    });

    it("calls sidecar.stopSession with mcode-{threadId} format", () => {
      const mockSidecar = attachMockSidecar(appState);

      appState.stopAgent(threadId);

      expect(mockSidecar.stopSession).toHaveBeenCalledWith(
        `mcode-${threadId}`,
      );
    });

    it("sets thread status to paused", () => {
      attachMockSidecar(appState);

      appState.stopAgent(threadId);

      const thread = ThreadRepo.findById(db, threadId);
      expect(thread?.status).toBe("paused");
    });

    it("handles null sidecar gracefully (no throw)", () => {
      // sidecar is null by default
      expect(() => appState.stopAgent(threadId)).not.toThrow();

      const thread = ThreadRepo.findById(db, threadId);
      expect(thread?.status).toBe("paused");
    });
  });

  // -------------------------------------------------------------------------
  // createAndSendMessage
  // -------------------------------------------------------------------------
  describe("createAndSendMessage", () => {
    let workspaceId: string;

    beforeEach(() => {
      const realDir = tmpdir();
      const ws = WorkspaceRepo.create(db, "proj", realDir);
      workspaceId = ws.id;

      // Reset fs mocks to delegate to real implementations
      resetFsMocks();
    });

    it("creates a direct thread with truncated title and sends message", async () => {
      attachMockSidecar(appState);

      const result = await appState.createAndSendMessage(
        workspaceId,
        "Hello world",
        "claude-sonnet-4-6",
        "default",
        "direct",
        "main",
      );

      expect(result.title).toBe("Hello world");
      expect(result.mode).toBe("direct");
      expect(result.model).toBe("claude-sonnet-4-6");

      // Message was persisted
      const msgs = MessageRepo.listByThread(db, result.id, 100);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("Hello world");
    });

    it("truncates title to 50 chars at word boundary with ellipsis", async () => {
      attachMockSidecar(appState);

      const longContent =
        "This is a very long message that should be truncated at a word boundary for the title";
      const result = await appState.createAndSendMessage(
        workspaceId,
        longContent,
        "claude-sonnet-4-6",
        "default",
        "direct",
        "main",
      );

      expect(result.title).toBe(
        "This is a very long message that should be...",
      );
    });

    it("uses first line only for title", async () => {
      attachMockSidecar(appState);

      const result = await appState.createAndSendMessage(
        workspaceId,
        "First line\nSecond line\nThird line",
        "claude-sonnet-4-6",
        "default",
        "direct",
        "main",
      );

      expect(result.title).toBe("First line");
    });

    it("defaults to 'New Thread' for empty content", async () => {
      attachMockSidecar(appState);

      const result = await appState.createAndSendMessage(
        workspaceId,
        "",
        "claude-sonnet-4-6",
        "default",
        "direct",
        "main",
      );

      expect(result.title).toBe("New Thread");
    });

    it("creates worktree-mode thread when mode is worktree", async () => {
      attachMockSidecar(appState);

      vi.mocked(createWorktree).mockReturnValue({
        name: "hello-12345678",
        path: "/tmp/wt/hello-12345678",
        branch: "mcode/hello-12345678",
        managed: true,
      });

      // For worktree mode, sendMessage uses the worktree_path as cwd.
      // Mock fs to accept the worktree path.
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(statSync).mockReturnValue({
        isDirectory: () => true,
      } as ReturnType<typeof statSync>);

      const result = await appState.createAndSendMessage(
        workspaceId,
        "Hello",
        "claude-sonnet-4-6",
        "default",
        "worktree",
        "main",
      );

      expect(result.mode).toBe("worktree");
      expect(createWorktree).toHaveBeenCalled();
    });

    it("returns updated thread from DB (with model set)", async () => {
      attachMockSidecar(appState);

      const result = await appState.createAndSendMessage(
        workspaceId,
        "Hello",
        "claude-opus-4-6",
        "default",
        "direct",
        "main",
      );

      // createAndSendMessage re-reads from DB, so model should be set
      expect(result.model).toBe("claude-opus-4-6");
    });
  });

  // -------------------------------------------------------------------------
  // deleteThread
  // -------------------------------------------------------------------------
  describe("deleteThread", () => {
    let workspaceId: string;
    let threadId: string;

    beforeEach(() => {
      const ws = WorkspaceRepo.create(db, "proj", "/tmp/proj");
      workspaceId = ws.id;
      const thread = ThreadRepo.create(
        db,
        workspaceId,
        "Test",
        "direct",
        "main",
      );
      threadId = thread.id;
    });

    it("soft-deletes the thread in the database", () => {
      const result = appState.deleteThread(threadId, false);
      expect(result).toBe(true);

      const thread = ThreadRepo.findById(db, threadId);
      expect(thread?.status).toBe("deleted");
      expect(thread?.deleted_at).toBeTruthy();
    });

    it("calls sidecar.stopSession when sidecar is present", () => {
      const mockSidecar = attachMockSidecar(appState);

      appState.deleteThread(threadId, false);

      expect(mockSidecar.stopSession).toHaveBeenCalledWith(
        `mcode-${threadId}`,
      );
    });

    it("handles null sidecar gracefully", () => {
      // sidecar is null by default
      expect(() => appState.deleteThread(threadId, false)).not.toThrow();
    });

    it("removes threadId from activeSessionIds", () => {
      const sessionIds = (
        appState as unknown as { activeSessionIds: Set<string> }
      ).activeSessionIds;
      sessionIds.add(threadId);

      appState.deleteThread(threadId, false);

      expect(sessionIds.has(threadId)).toBe(false);
    });

    it("calls removeWorktree when cleanupWorktree=true and thread has worktree_path", () => {
      attachMockSidecar(appState);

      // Set up a thread with a worktree path
      ThreadRepo.updateWorktreePath(
        db,
        threadId,
        "/home/user/.mcode/worktrees/proj/feature-abc",
      );

      appState.deleteThread(threadId, true);

      expect(removeWorktree).toHaveBeenCalledWith(
        "/tmp/proj",
        "feature-abc", // last path segment
        "main", // thread.branch
      );
    });

    it("skips removeWorktree when cleanupWorktree=false", () => {
      attachMockSidecar(appState);
      ThreadRepo.updateWorktreePath(db, threadId, "/tmp/wt/feature");

      appState.deleteThread(threadId, false);

      expect(removeWorktree).not.toHaveBeenCalled();
    });

    it("skips removeWorktree when thread has no worktree_path", () => {
      attachMockSidecar(appState);

      appState.deleteThread(threadId, true);

      expect(removeWorktree).not.toHaveBeenCalled();
    });

    it("returns false for nonexistent thread", () => {
      const result = appState.deleteThread("nonexistent", false);
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // shutdown
  // -------------------------------------------------------------------------
  describe("shutdown", () => {
    let workspaceId: string;

    beforeEach(() => {
      const ws = WorkspaceRepo.create(db, "proj", "/tmp/proj");
      workspaceId = ws.id;
    });

    it("stops all active sessions via sidecar", () => {
      const mockSidecar = attachMockSidecar(appState);
      const t1 = ThreadRepo.create(db, workspaceId, "T1", "direct", "main");
      const t2 = ThreadRepo.create(db, workspaceId, "T2", "direct", "main");

      appState.trackSessionStarted(t1.id);
      appState.trackSessionStarted(t2.id);

      appState.shutdown();

      expect(mockSidecar.stopSession).toHaveBeenCalledWith(`mcode-${t1.id}`);
      expect(mockSidecar.stopSession).toHaveBeenCalledWith(`mcode-${t2.id}`);
    });

    it("calls sidecar.shutdown()", () => {
      const mockSidecar = attachMockSidecar(appState);
      appState.trackSessionStarted("some-thread");

      appState.shutdown();

      expect(mockSidecar.shutdown).toHaveBeenCalled();
    });

    it("marks active threads as interrupted in the database", () => {
      attachMockSidecar(appState);
      const t1 = ThreadRepo.create(db, workspaceId, "T1", "direct", "main");
      const t2 = ThreadRepo.create(db, workspaceId, "T2", "direct", "main");

      appState.trackSessionStarted(t1.id);
      appState.trackSessionStarted(t2.id);

      // Spy on ThreadRepo.updateStatus to verify it's called with "interrupted"
      // before the DB is closed by shutdown()
      const updateStatusSpy = vi.spyOn(ThreadRepo, "updateStatus");

      try {
        appState.shutdown();

        expect(updateStatusSpy).toHaveBeenCalledWith(db, t1.id, "interrupted");
        expect(updateStatusSpy).toHaveBeenCalledWith(db, t2.id, "interrupted");
      } finally {
        updateStatusSpy.mockRestore();
      }
    });

    it("clears activeSessionIds after shutdown", () => {
      attachMockSidecar(appState);
      appState.trackSessionStarted("t1");
      appState.trackSessionStarted("t2");

      appState.shutdown();

      expect(appState.activeAgentCount()).toBe(0);
    });

    it("closes the database", () => {
      attachMockSidecar(appState);

      appState.shutdown();

      // After shutdown, DB operations should fail
      expect(() => db.prepare("SELECT 1").get()).toThrow();
    });

    it("handles shutdown with no sidecar gracefully", () => {
      // sidecar is null by default
      const t = ThreadRepo.create(db, workspaceId, "T", "direct", "main");
      appState.trackSessionStarted(t.id);

      expect(() => appState.shutdown()).not.toThrow();
    });

    it("handles shutdown with no active sessions", () => {
      attachMockSidecar(appState);

      expect(() => appState.shutdown()).not.toThrow();
    });

    it("sets sidecar to null after shutdown", () => {
      attachMockSidecar(appState);

      appState.shutdown();

      const sidecarRef = (appState as unknown as { sidecar: unknown }).sidecar;
      expect(sidecarRef).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // session tracking
  // -------------------------------------------------------------------------
  describe("session tracking", () => {
    it("trackSessionStarted increases active count", () => {
      appState.trackSessionStarted("t1");
      expect(appState.activeAgentCount()).toBe(1);

      appState.trackSessionStarted("t2");
      expect(appState.activeAgentCount()).toBe(2);
    });

    it("trackSessionEnded decreases active count", () => {
      appState.trackSessionStarted("t1");
      appState.trackSessionStarted("t2");
      appState.trackSessionEnded("t1");
      expect(appState.activeAgentCount()).toBe(1);
    });

    it("duplicate trackSessionStarted does not double-count (Set)", () => {
      appState.trackSessionStarted("t1");
      appState.trackSessionStarted("t1");
      expect(appState.activeAgentCount()).toBe(1);
    });

    it("trackSessionEnded for unknown ID is a no-op", () => {
      expect(() => appState.trackSessionEnded("unknown")).not.toThrow();
      expect(appState.activeAgentCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // workspace / thread listing pass-through
  // -------------------------------------------------------------------------
  describe("workspace and thread listing", () => {
    it("createWorkspace and listWorkspaces round-trip", () => {
      const ws = appState.createWorkspace("proj", "/tmp/proj");
      const list = appState.listWorkspaces();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(ws.id);
    });

    it("deleteWorkspace returns true and removes workspace", () => {
      const ws = appState.createWorkspace("proj", "/tmp/proj");
      expect(appState.deleteWorkspace(ws.id)).toBe(true);
      expect(appState.listWorkspaces()).toHaveLength(0);
    });

    it("listThreads returns threads for workspace", () => {
      const ws = appState.createWorkspace("proj", "/tmp/proj");
      appState.createThread(ws.id, "T1", "direct", "main");
      const threads = appState.listThreads(ws.id);
      expect(threads).toHaveLength(1);
    });

    it("getMessages returns messages for thread", () => {
      const ws = appState.createWorkspace("proj", "/tmp/proj");
      const thread = appState.createThread(ws.id, "T1", "direct", "main");
      MessageRepo.create(db, thread.id, "user", "Hello", 1);
      const msgs = appState.getMessages(thread.id, 100);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("Hello");
    });

    it("updateThreadTitle updates the title", () => {
      const ws = appState.createWorkspace("proj", "/tmp/proj");
      const thread = appState.createThread(ws.id, "Old", "direct", "main");
      expect(appState.updateThreadTitle(thread.id, "New")).toBe(true);
      const found = ThreadRepo.findById(db, thread.id);
      expect(found?.title).toBe("New");
    });
  });
});
