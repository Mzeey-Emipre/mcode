import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ThreadControlService, type InternalThreadControlAuthority } from "../thread-control-service.js";

const authority: InternalThreadControlAuthority = {
  type: "internal",
  userId: "local-user",
  sourceThreadId: "thread-1",
  sourceTurnId: "turn-1",
  sourceToolCallId: "call-1",
  sourceProviderId: "claude",
  permissionMode: "supervised",
};

describe("ThreadControlService", () => {
  it("never returns a registered workspace filesystem path from workspace_search", () => {
    const workspacePath = "C:/private/workspace";
    const service = new ThreadControlService(
      { search: () => [{ id: "workspace-1", name: "Workspace", path: workspacePath, last_opened_at: null }] } as never,
      {} as never,
      {} as never,
    );

    const result = service.workspaceSearch(authority, { limit: 20 });

    expect(JSON.stringify(result)).not.toContain(workspacePath);
    expect(result.workspaces).toEqual([{ workspaceId: "workspace-1", name: "Workspace" }]);
  });
});
