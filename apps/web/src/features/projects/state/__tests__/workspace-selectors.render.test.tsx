import { Profiler, type ProfilerOnRenderCallback } from "react";
import { render, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceThread } from "../workspace-selectors";
import { useWorkspaceStore } from "../workspaceStore";
import type { WorkspaceThread } from "@/lib/workspace-thread";

function thread(id: string, title: string, status: WorkspaceThread["status"] = "paused"): WorkspaceThread {
  return { id, title, status } as WorkspaceThread;
}

function ThreadTitleProbe({ threadId }: { threadId: string }) {
  const title = useWorkspaceThread(threadId, (t) => t?.title);
  return <span data-testid="title">{title}</span>;
}

describe("useWorkspaceThread render isolation", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      threads: [thread("thread-a", "Thread A"), thread("thread-b", "Thread B")],
      activeThreadId: "thread-a",
    });
  });

  it("does not re-render when an unrelated thread row updates", () => {
    const renderCounts = new Map<string, number>();
    const onRender: ProfilerOnRenderCallback = (_id, _phase, _actualDuration, _baseDuration, _startTime, _commitTime) => {
      renderCounts.set("probe", (renderCounts.get("probe") ?? 0) + 1);
    };

    render(
      <Profiler id="probe" onRender={onRender}>
        <ThreadTitleProbe threadId="thread-a" />
      </Profiler>,
    );

    expect(renderCounts.get("probe")).toBe(1);

    act(() => {
      useWorkspaceStore.setState((state) => ({
        threads: state.threads.map((row) =>
          row.id === "thread-b" ? { ...row, title: "Thread B updated" } : row,
        ),
      }));
    });

    expect(renderCounts.get("probe")).toBe(1);
  });

  it("re-renders when the subscribed thread row changes", () => {
    const renderCounts = new Map<string, number>();
    const onRender: ProfilerOnRenderCallback = () => {
      renderCounts.set("probe", (renderCounts.get("probe") ?? 0) + 1);
    };

    render(
      <Profiler id="probe" onRender={onRender}>
        <ThreadTitleProbe threadId="thread-a" />
      </Profiler>,
    );

    act(() => {
      useWorkspaceStore.setState((state) => ({
        threads: state.threads.map((row) =>
          row.id === "thread-a" ? { ...row, title: "Thread A updated" } : row,
        ),
      }));
    });

    expect(renderCounts.get("probe")).toBe(2);
  });
});
