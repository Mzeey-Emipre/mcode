import { describe, expect, it, vi } from "vitest";
import { routeFileRpc } from "../file-rpc.js";

describe("file RPC invalidation", () => {
  it.each([
    ["file.list", { workspaceId: "workspace-1" }, ["src/file.ts"]],
    ["file.read", { workspaceId: "workspace-1", relativePath: "src/file.ts" }, "contents"],
    ["file.watch", { workspaceId: "workspace-1" }, undefined],
  ] as const)("starts the connection-owned local watcher after %s", async (method, params, expected) => {
    const fileService = {
      list: vi.fn().mockResolvedValue(["src/file.ts"]),
      read: vi.fn().mockResolvedValue("contents"),
      resolveWorkingDir: vi.fn().mockReturnValue("C:/workspace"),
    };
    const workspaceInvalidations = { watch: vi.fn() };
    const client = {} as WebSocket;

    await expect(routeFileRpc(method, params, { fileService, workspaceInvalidations }, client)).resolves.toEqual(expected);

    expect(workspaceInvalidations.watch).toHaveBeenCalledWith(client, "workspace-1", undefined, "C:/workspace");
  });
});
