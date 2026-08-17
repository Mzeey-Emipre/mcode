import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { refreshBrowserAutomationHostAuthorization } from "../ws-server.js";

describe("browser automation WebSocket authorization", () => {
  it("refreshes workspace scope without changing the connection desktop identity", () => {
    const refreshed = refreshBrowserAutomationHostAuthorization({
      desktopInstanceId: "new-random-id",
      worktreeIdentity: "worktree-a",
      allowedWorkspaceIds: ["workspace-a", "workspace-created-after-connect"],
    }, "stable-connection-id");

    expect(refreshed).toEqual({
      desktopInstanceId: "stable-connection-id",
      worktreeIdentity: "worktree-a",
      allowedWorkspaceIds: ["workspace-a", "workspace-created-after-connect"],
    });
  });
});
