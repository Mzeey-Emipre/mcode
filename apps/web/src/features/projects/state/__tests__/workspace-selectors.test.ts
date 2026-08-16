import { describe, it, expect } from "vitest";
import { getWorkspaceThread } from "../workspace-selectors";
import type { WorkspaceThread } from "@/lib/workspace-thread";

function thread(id: string, title: string): WorkspaceThread {
  return { id, title } as WorkspaceThread;
}

describe("getWorkspaceThread", () => {
  it("returns one row without scanning unrelated updates", () => {
    const threads = [thread("a", "A"), thread("b", "B")];
    expect(getWorkspaceThread(threads, "b")?.title).toBe("B");
  });

  it("returns undefined for missing ids", () => {
    expect(getWorkspaceThread([thread("a", "A")], "missing")).toBeUndefined();
  });
});
