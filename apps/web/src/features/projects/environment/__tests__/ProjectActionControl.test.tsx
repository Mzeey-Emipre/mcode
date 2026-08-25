import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentActionRun, WorkspaceEnvironmentReadResult } from "@mcode/contracts";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ProjectActionMenu, ProjectActionTerminalView, useProjectActions } from "../ProjectActionControl";
import { useProjectActionStore } from "../state/project-action-store";

const { transport } = vi.hoisted(() => ({
  transport: {
    readWorkspaceEnvironment: vi.fn(),
    listWorkspaceActionRuns: vi.fn(),
    restartWorkspaceAction: vi.fn(),
    stopWorkspaceAction: vi.fn(),
  },
}));

vi.mock("@/transport", () => ({ getTransport: () => transport }));

const action = { id: "build", name: "Build", command: { default: "bun run build" } };

const completedRun: WorkspaceEnvironmentActionRun = {
  threadId: "thread-1",
  workspaceId: "workspace-1",
  actionId: "build",
  runId: "run-1",
  revision: 1,
  terminalSessionId: "terminal-1",
  actionName: "Build",
  status: "completed",
  snapshot: {
    platform: "windows",
    script: "bun run build",
    checkoutPath: "C:\\repo",
    terminal: { executable: "powershell.exe", arguments: ["-Command", "bun run build"] },
    environmentNames: ["PATH"],
  },
  createdAt: "2026-08-22T12:00:00.000Z",
  startedAt: "2026-08-22T12:00:00.000Z",
  finishedAt: "2026-08-22T12:00:01.000Z",
  exitCode: 0,
  transcript: "done",
  transcriptTruncated: false,
};

function ActionHydrationHarness() {
  const { runsByActionId } = useProjectActions("workspace-1", "thread-1");
  const build = runsByActionId.get("build")?.status ?? "missing";
  const phantom = runsByActionId.has("phantom") ? "present" : "removed";
  return <output data-testid="action-hydration-state">{`${build}:${phantom}`}</output>;
}

function SetupAvailabilityHarness({ workspaceId, threadId }: { readonly workspaceId: string; readonly threadId: string }) {
  const { hasSetup } = useProjectActions(workspaceId, threadId);
  return <output data-testid="setup-availability">{hasSetup ? "configured" : "absent"}</output>;
}

describe("ProjectAction controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectActionStore.setState({
      runsByThread: {},
      configurationEpochByWorkspace: {},
      updateEpochByThread: {},
      updateEpochByThreadAction: {},
      hydrationByThread: {},
    });
  });

  it("keeps a new launch in the background and focuses an already running slot", async () => {
    const user = userEvent.setup();
    const start = vi.fn().mockResolvedValue(undefined);
    const focus = vi.fn();
    const { rerender } = render(
      <ProjectActionMenu actions={[action]} runsByActionId={new Map()} onStart={start} onFocus={focus} onEdit={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Build/ }));
    expect(start).toHaveBeenCalledWith("build");
    expect(focus).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: /Build/ })).toBeInTheDocument();

    rerender(
      <ProjectActionMenu
        actions={[action]}
        runsByActionId={new Map([["build", { ...completedRun, status: "running", finishedAt: null, exitCode: null }]])}
        onStart={start}
        onFocus={focus}
        onEdit={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: /Build/ }));
    expect(focus).toHaveBeenCalledWith("build");
  });

  it("groups Edit, configured Actions, and Run Setup in visible menu order", async () => {
    const user = userEvent.setup();
    render(
      <ProjectActionMenu
        actions={[action]}
        runsByActionId={new Map()}
        onStart={vi.fn().mockResolvedValue(undefined)}
        onFocus={vi.fn()}
        onEdit={vi.fn()}
        setupMenuItem={<DropdownMenuItem>Run Setup</DropdownMenuItem>}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project Actions" }));

    const menuItems = await screen.findAllByRole("menuitem");
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "Edit project actions",
      "Build",
      "Run Setup",
    ]);
    expect(menuItems[0].firstElementChild).toHaveClass("lucide-pencil");
    const play = menuItems[1].querySelector('[aria-label="Play"]');
    expect(play).toBe(menuItems[1].lastElementChild);
    const content = menuItems[0].closest('[data-slot="dropdown-menu-content"]');
    expect(content?.querySelectorAll('[data-slot="dropdown-menu-separator"]')).toHaveLength(2);
  });

  it("does not create a blank Action group for an empty load error", async () => {
    const user = userEvent.setup();
    render(
      <ProjectActionMenu
        actions={[]}
        runsByActionId={new Map()}
        loadError=""
        onStart={vi.fn().mockResolvedValue(undefined)}
        onFocus={vi.fn()}
        onEdit={vi.fn()}
        setupMenuItem={<DropdownMenuItem>Run Setup</DropdownMenuItem>}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project Actions" }));

    const menuItems = await screen.findAllByRole("menuitem");
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "Edit project actions",
      "Run Setup",
    ]);
    const content = menuItems[0].closest('[data-slot="dropdown-menu-content"]');
    expect(content?.querySelectorAll('[data-slot="dropdown-menu-separator"]')).toHaveLength(1);
  });

  it("reports a rejected launch instead of silently discarding it", async () => {
    const user = userEvent.setup();
    render(
      <ProjectActionMenu
        actions={[action]}
        runsByActionId={new Map()}
        onStart={vi.fn().mockRejectedValue(new Error("capacity reached"))}
        onFocus={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Build/ }));

    expect(await screen.findByRole("status")).toHaveTextContent("Project Action could not start.");
  });

  it("keeps a deleted Action row available for retained result inspection", async () => {
    const user = userEvent.setup();
    const focus = vi.fn();
    render(
      <ProjectActionMenu
        actions={[]}
        runsByActionId={new Map([["build", completedRun]])}
        onStart={vi.fn().mockResolvedValue(undefined)}
        onFocus={focus}
        onEdit={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    expect(await screen.findByLabelText("Play")).toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: /Build/ }));

    expect(focus).toHaveBeenCalledWith("build");
  });

  it("renders the running icon without visible pill text", async () => {
    const user = userEvent.setup();
    render(
      <ProjectActionMenu
        actions={[action]}
        runsByActionId={new Map([["build", { ...completedRun, status: "running", finishedAt: null, exitCode: null }]])}
        onStart={vi.fn().mockResolvedValue(undefined)}
        onFocus={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project Actions" }));

    const running = await screen.findByRole("status", { name: "Running" });
    expect(running).not.toHaveTextContent("Running");
    expect(running.closest("[class*='group/badge']")).toBeNull();
    expect(running.querySelector(".spinner-tail-fade")).toHaveClass("motion-reduce:animate-none");
  });

  it("keeps the completed icon for two seconds, then exposes Play", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-22T12:00:01.000Z"));
      act(() => useProjectActionStore.getState().applyRun(completedRun));
      render(<ProjectActionTerminalView threadId="thread-1" actionId="build" />);
      const completed = screen.getByRole("status", { name: "Completed" });
      expect(completed).not.toHaveTextContent("Completed");
      expect(completed.closest("[class*='group/badge']")).toBeNull();
      expect(completed.querySelector(".lucide-circle-check")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(screen.getByLabelText("Play")).toBeInTheDocument();
      expect(screen.getByText("done")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart the completed icon when an old result remounts", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-22T12:00:01.000Z"));
      act(() => useProjectActionStore.getState().applyRun(completedRun));

      const first = render(<ProjectActionTerminalView threadId="thread-1" actionId="build" />);
      expect(screen.getByRole("status", { name: "Completed" })).toBeInTheDocument();
      first.unmount();
      act(() => { vi.advanceTimersByTime(2_000); });

      render(<ProjectActionTerminalView threadId="thread-1" actionId="build" />);
      expect(screen.getByLabelText("Play")).toBeInTheDocument();
      expect(screen.queryByRole("status", { name: "Completed" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts a running Action from its retained terminal after the server stop barrier", async () => {
    const user = userEvent.setup();
    const running = { ...completedRun, status: "running" as const, finishedAt: null, exitCode: null };
    const restarted = {
      ...running,
      runId: "run-2",
      revision: 0,
      terminalSessionId: "terminal-2",
      createdAt: "2026-08-22T12:00:02.000Z",
      startedAt: "2026-08-22T12:00:02.000Z",
    };
    transport.restartWorkspaceAction.mockResolvedValue(restarted);
    act(() => useProjectActionStore.getState().applyRun(running));

    render(<ProjectActionTerminalView threadId="thread-1" actionId="build" />);
    await user.click(screen.getByRole("button", { name: "Restart Build" }));

    await waitFor(() => expect(transport.restartWorkspaceAction).toHaveBeenCalledWith("thread-1", "build"));
    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build).toMatchObject({
      runId: "run-2",
      terminalSessionId: "terminal-2",
      status: "running",
    });
  });

  it("reports a failed stop without removing the running Action result", async () => {
    const user = userEvent.setup();
    const running = { ...completedRun, status: "running" as const, finishedAt: null, exitCode: null };
    transport.stopWorkspaceAction.mockRejectedValue(new Error("cleanup failed"));
    act(() => useProjectActionStore.getState().applyRun(running));

    render(<ProjectActionTerminalView threadId="thread-1" actionId="build" />);
    await user.click(screen.getByRole("button", { name: "Stop Build" }));

    await waitFor(() => expect(transport.stopWorkspaceAction).toHaveBeenCalledWith("thread-1", "build"));
    expect(await screen.findByText("Project Action could not stop.")).toBeInTheDocument();
    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build).toMatchObject({
      runId: "run-1",
      status: "running",
    });
  });

  it("keeps the failed icon for two seconds, then exposes Play", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-22T12:00:01.000Z"));
      act(() => useProjectActionStore.getState().applyRun({ ...completedRun, status: "failed", exitCode: 1 }));
      render(<ProjectActionTerminalView threadId="thread-1" actionId="build" />);

      const failed = screen.getByRole("status", { name: "Failed" });
      expect(failed).not.toHaveTextContent("Failed");
      expect(failed.querySelector(".lucide-circle-x")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(screen.getByLabelText("Play")).toBeInTheDocument();
      expect(screen.queryByRole("status", { name: "Failed" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["interrupted", "Interrupted", "lucide-circle-stop"],
    ["unavailable", "Unavailable", "lucide-circle-slash"],
  ] as const)("keeps the %s icon after the result display window", (status, label, iconClass) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-22T12:00:01.000Z"));
      act(() => useProjectActionStore.getState().applyRun({ ...completedRun, status, exitCode: 1 }));
      render(<ProjectActionTerminalView threadId="thread-1" actionId="build" />);

      act(() => { vi.advanceTimersByTime(2_000); });
      const result = screen.getByRole("status", { name: label });
      expect(result).not.toHaveTextContent(label);
      expect(result.querySelector(`.${iconClass}`)).toBeInTheDocument();
      expect(screen.queryByLabelText("Play")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders ANSI transcript text without exposing control sequences", () => {
    act(() => useProjectActionStore.getState().applyRun({
      ...completedRun,
      transcript: "\u001b[32mgreen output\u001b[0m",
    }));

    render(<ProjectActionTerminalView threadId="thread-1" actionId="build" />);

    expect(screen.getByText("green output")).toHaveClass("text-emerald-500");
    expect(screen.getByLabelText("Build output").textContent).not.toContain("\u001b[");
  });

  it("does not expose stale Setup availability after its scope changes", async () => {
    const configuredEnvironment = {
      document: { version: "0.0.1" as const, setup: { default: "bun run setup" }, actions: [] },
      revision: "revision-1",
      status: "present" as const,
    } satisfies WorkspaceEnvironmentReadResult;
    let resolveCurrentB!: (result: WorkspaceEnvironmentReadResult) => void;
    const currentB = new Promise<WorkspaceEnvironmentReadResult>((resolve) => {
      resolveCurrentB = resolve;
    });
    transport.readWorkspaceEnvironment
      .mockResolvedValueOnce(configuredEnvironment)
      .mockReturnValueOnce(currentB);
    transport.listWorkspaceActionRuns.mockResolvedValue([]);

    const view = render(<SetupAvailabilityHarness workspaceId="workspace-a" threadId="thread-a" />);
    await screen.findByText("configured");

    view.rerender(<SetupAvailabilityHarness workspaceId="workspace-b" threadId="thread-b" />);
    expect(screen.getByTestId("setup-availability")).toHaveTextContent("absent");

    await act(async () => { resolveCurrentB(configuredEnvironment); });
    await screen.findByText("configured");
  });

  it("retains a post-request push while pruning a pre-request omitted phantom", async () => {
    let resolveList!: (runs: readonly WorkspaceEnvironmentActionRun[]) => void;
    transport.readWorkspaceEnvironment.mockResolvedValue({
      document: { version: "0.0.1", actions: [action] },
    });
    transport.listWorkspaceActionRuns.mockReturnValueOnce(new Promise((resolve) => {
      resolveList = resolve;
    }));
    act(() => useProjectActionStore.getState().applyRun({
      ...completedRun,
      actionId: "phantom",
      actionName: "Deleted Action",
      runId: "phantom-run",
    }));

    render(<ActionHydrationHarness />);
    await waitFor(() => expect(transport.listWorkspaceActionRuns).toHaveBeenCalledWith("thread-1"));

    act(() => useProjectActionStore.getState().applyRun({
      ...completedRun,
      revision: 2,
      transcript: "completed after the request began",
    }));
    act(() => resolveList([{
      ...completedRun,
      revision: 0,
      status: "running",
      finishedAt: null,
      exitCode: null,
      transcript: "stale list result",
    }]));

    await waitFor(() => {
      expect(screen.getByTestId("action-hydration-state")).toHaveTextContent("completed:removed");
    });
    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build).toMatchObject({
      revision: 2,
      status: "completed",
    });
  });

  it("ignores an in-flight Action list after its Thread is cleared", async () => {
    let resolveList!: (runs: readonly WorkspaceEnvironmentActionRun[]) => void;
    transport.readWorkspaceEnvironment.mockResolvedValue({
      document: { version: "0.0.1", actions: [action] },
    });
    transport.listWorkspaceActionRuns.mockReturnValueOnce(new Promise((resolve) => {
      resolveList = resolve;
    }));

    render(<ActionHydrationHarness />);
    await waitFor(() => expect(transport.listWorkspaceActionRuns).toHaveBeenCalledWith("thread-1"));
    act(() => useProjectActionStore.getState().clearThread("thread-1"));
    await act(async () => { resolveList([completedRun]); });

    expect(useProjectActionStore.getState().runsByThread["thread-1"]).toBeUndefined();
  });

  it("does not hydrate Action state after its hook unmounts", async () => {
    let resolveList!: (runs: readonly WorkspaceEnvironmentActionRun[]) => void;
    transport.readWorkspaceEnvironment.mockResolvedValue({
      document: { version: "0.0.1", actions: [action] },
    });
    transport.listWorkspaceActionRuns.mockReturnValueOnce(new Promise((resolve) => {
      resolveList = resolve;
    }));

    const view = render(<ActionHydrationHarness />);
    await waitFor(() => expect(transport.listWorkspaceActionRuns).toHaveBeenCalledWith("thread-1"));
    view.unmount();
    await act(async () => { resolveList([completedRun]); });

    expect(useProjectActionStore.getState().runsByThread["thread-1"]).toBeUndefined();
  });
});
