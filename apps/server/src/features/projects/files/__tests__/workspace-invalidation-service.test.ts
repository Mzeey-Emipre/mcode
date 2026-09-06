import "reflect-metadata";
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { existsSyncMock, watchMock, realpathSyncMock, sendToClientMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  watchMock: vi.fn(),
  realpathSyncMock: vi.fn(),
  sendToClientMock: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: existsSyncMock, watch: watchMock, realpathSync: realpathSyncMock };
});

vi.mock("../../../../application/transport/push.js", () => ({ sendToClient: sendToClientMock }));

import { WorkspaceInvalidationService } from "../workspace-invalidation-service.js";

class MockWatcher extends NodeEvents.EventEmitter {
  close = vi.fn();
}

describe("WorkspaceInvalidationService", () => {
  let callbacks: Array<(event: string, filename: string | Buffer | null) => void>;
  let service: WorkspaceInvalidationService;
  const client = {} as WebSocket;
  const root = NodePath.resolve("workspace-root");

  beforeEach(() => {
    vi.useFakeTimers();
    callbacks = [];
    sendToClientMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    realpathSyncMock.mockImplementation((path) => path.toString());
    watchMock.mockReset();
    watchMock.mockImplementation((_root: string, _options: unknown, callback: (event: string, filename: string | Buffer | null) => void) => {
      callbacks.push(callback);
      return new MockWatcher();
    });
    service = new WorkspaceInvalidationService();
  });

  it("debounces a bounded path list for one workspace scope", () => {
    service.watch(client, "workspace-1", "thread-1", root);
    service.watch(client, "workspace-1", "thread-1", root);

    callbacks[0]("change", NodePath.join("src", "one.ts"));
    callbacks[0]("change", NodePath.join("src", "two.ts"));
    vi.advanceTimersByTime(100);

    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(sendToClientMock).toHaveBeenCalledWith(client, "files.changed", {
      workspaceId: "workspace-1",
      threadId: "thread-1",
      changedPaths: [NodePath.join("src", "one.ts"), NodePath.join("src", "two.ts")],
      wholeWorkspace: false,
    });
  });

  it("rejects an outside-root path before it reaches consumers", () => {
    service.watch(client, "workspace-1", undefined, root);
    callbacks[0]("change", NodePath.resolve(root, "..", "outside.ts"));
    vi.advanceTimersByTime(100);

    expect(sendToClientMock).not.toHaveBeenCalled();
  });

  it("rejects a symlinked descendant that resolves outside the canonical root", () => {
    const outsideRoot = NodePath.resolve(root, "..", "outside-root");
    realpathSyncMock.mockImplementation((path) => {
      const candidate = path.toString();
      return candidate.startsWith(NodePath.join(root, "linked"))
        ? candidate.replace(root, outsideRoot)
        : candidate;
    });
    service.watch(client, "workspace-1", undefined, root);
    callbacks[0]("change", NodePath.join("linked", "secret.ts"));
    vi.advanceTimersByTime(100);

    expect(sendToClientMock).not.toHaveBeenCalled();
  });

  it("uses the nearest surviving ancestor when a path disappears during canonicalization", () => {
    const changedPath = NodePath.resolve(root, "src", "removed.ts");
    realpathSyncMock.mockImplementation((path) => {
      if (path.toString() === changedPath) {
        throw Object.assign(new Error("removed during rename"), { code: "ENOENT" });
      }
      return path.toString();
    });
    service.watch(client, "workspace-1", undefined, root);

    expect(() => callbacks[0]("rename", NodePath.join("src", "removed.ts"))).not.toThrow();
    vi.advanceTimersByTime(100);

    expect(sendToClientMock).toHaveBeenCalledWith(client, "files.changed", {
      workspaceId: "workspace-1",
      changedPaths: [NodePath.join("src", "removed.ts")],
      wholeWorkspace: false,
    });
  });

  it("keeps a deleted top-level file when its workspace root is the surviving ancestor", () => {
    const changedPath = NodePath.resolve(root, "removed.ts");
    existsSyncMock.mockImplementation((path) => path.toString() !== changedPath);
    service.watch(client, "workspace-1", undefined, root);
    callbacks[0]("rename", "removed.ts");
    vi.advanceTimersByTime(100);

    expect(sendToClientMock).toHaveBeenCalledWith(client, "files.changed", {
      workspaceId: "workspace-1",
      changedPaths: ["removed.ts"],
      wholeWorkspace: false,
    });
  });

  it("uses whole-workspace invalidation when the changed path limit overflows", () => {
    service.watch(client, "workspace-1", undefined, root);
    for (let index = 0; index <= 100; index++) callbacks[0]("change", `file-${index}.ts`);
    vi.advanceTimersByTime(100);

    expect(sendToClientMock).toHaveBeenCalledWith(client, "files.changed", {
      workspaceId: "workspace-1",
      changedPaths: [],
      wholeWorkspace: true,
    });
  });

  it("ignores transient Git fsmonitor cookies but keeps Git index changes", () => {
    service.watch(client, "workspace-1", undefined, root);
    callbacks[0]("change", NodePath.join(".git", "fsmonitor--daemon", "cookies", "123"));
    callbacks[0]("change", NodePath.join(".git", "index"));
    vi.advanceTimersByTime(100);

    expect(sendToClientMock).toHaveBeenCalledWith(client, "files.changed", {
      workspaceId: "workspace-1",
      changedPaths: [NodePath.join(".git", "index")],
      wholeWorkspace: false,
    });
  });

  it("closes every client-owned watch and ignores later watcher callbacks", () => {
    service.watch(client, "workspace-1", undefined, root);
    const watcher = watchMock.mock.results[0].value as MockWatcher;
    callbacks[0]("change", "src/file.ts");
    service.unwatchClient(client);
    callbacks[0]("change", "src/after-close.ts");
    vi.advanceTimersByTime(100);

    expect(watcher.close).toHaveBeenCalledOnce();
    expect(sendToClientMock).not.toHaveBeenCalled();
  });

  it("uses whole-workspace invalidation when the watcher omits a filename", () => {
    service.watch(client, "workspace-1", undefined, root);
    callbacks[0]("change", null);
    vi.advanceTimersByTime(100);

    expect(sendToClientMock).toHaveBeenCalledWith(client, "files.changed", {
      workspaceId: "workspace-1",
      changedPaths: [],
      wholeWorkspace: true,
    });
  });

  it("removes a failed watch so it cannot publish later changes", () => {
    service.watch(client, "workspace-1", undefined, root);
    const watcher = watchMock.mock.results[0].value as MockWatcher;
    watcher.emit("error", new Error("watch failed"));
    callbacks[0]("change", "src/after-error.ts");
    vi.advanceTimersByTime(100);

    expect(watcher.close).toHaveBeenCalledOnce();
    expect(sendToClientMock).not.toHaveBeenCalled();
  });
});
