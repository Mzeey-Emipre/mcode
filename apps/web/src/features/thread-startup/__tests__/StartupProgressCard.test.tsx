import type { ThreadStartup } from "@mcode/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const startupTransport = {
  cancelThreadStartup: vi.fn(),
};

vi.mock("@/transport", () => ({
  getTransport: () => startupTransport,
}));

import { StartupProgressCard } from "../StartupProgressCard";
import { useThreadStartupStore } from "../state/thread-startup-store";

const startupId = "00000000-0000-4000-8000-000000000001";

function startup(overrides: Partial<ThreadStartup> = {}): ThreadStartup {
  return {
    startupId,
    workspaceId: "workspace-1",
    kind: "managed-worktree",
    state: "running",
    phase: "setup",
    steps: [
      { phase: "thread", state: "completed" },
      { phase: "worktree", state: "completed" },
      { phase: "setup", state: "running" },
      { phase: "agent", state: "pending" },
    ],
    transcript: [],
    cancellation: "none",
    revision: 1,
    threadId: "thread-1",
    createdAt: "2026-09-02T12:00:00.000Z",
    updatedAt: "2026-09-02T12:00:00.000Z",
    ...overrides,
  };
}

function StartupCardHarness() {
  const record = useThreadStartupStore((state) => state.recordsByStartupId[startupId]);
  return <StartupProgressCard startup={record} startupId={startupId} context="managed-worktree" />;
}

describe("StartupProgressCard", () => {
  afterEach(() => {
    startupTransport.cancelThreadStartup.mockReset();
    useThreadStartupStore.setState({ recordsByStartupId: {}, startupIdByThreadId: {} });
  });

  it("uses the approved Direct and managed placeholder step layouts", () => {
    const direct = render(<StartupProgressCard startupId={startupId} context="direct" />);
    const directSteps = screen.getAllByRole("listitem");
    expect(directSteps).toHaveLength(2);
    expect(directSteps.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Use project checkout"),
      expect.stringContaining("Start agent"),
    ]);
    direct.unmount();

    render(<StartupProgressCard startupId={startupId} context="managed-worktree" />);
    const managedSteps = screen.getAllByRole("listitem");
    expect(managedSteps).toHaveLength(3);
    expect(managedSteps.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Prepare checkout"),
      expect.stringContaining("Run project setup"),
      expect.stringContaining("Start agent"),
    ]);
  });

  it("projects managed thread creation into checkout preparation", () => {
    render(
      <StartupProgressCard
        startup={startup({
          phase: "thread",
          steps: [
            { phase: "thread", state: "running" },
            { phase: "worktree", state: "pending" },
            { phase: "setup", state: "pending" },
            { phase: "agent", state: "pending" },
          ],
        })}
        startupId={startupId}
        context="managed-worktree"
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Prepare checkout").closest("li")).toHaveAttribute("data-state", "running");
    expect(screen.getByTestId("startup-activity")).toHaveTextContent("Creating a");
    expect(screen.getByTestId("startup-activity")).toHaveTextContent("worktree");
    expect(screen.queryByText("Creating a thread")).toBeNull();
  });

  it("uses native details and updates the live transcript", async () => {
    const user = userEvent.setup();
    const initial = startup({
      transcript: [{ phase: "setup", content: "setup started", createdAt: "2026-09-02T12:00:00.000Z" }],
    });
    const view = render(<StartupProgressCard startup={initial} startupId={startupId} context="managed-worktree" />);

    const summary = screen.getByText("More details");
    expect(summary.tagName).toBe("SUMMARY");
    await user.click(summary);
    expect(screen.getByText("Less details")).toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveTextContent("setup started");

    view.rerender(<StartupProgressCard startup={startup({
      revision: 2,
      transcript: [
        ...initial.transcript,
        { phase: "setup", content: "setup finished", createdAt: "2026-09-02T12:00:01.000Z" },
      ],
    })} startupId={startupId} context="managed-worktree" />);

    expect(screen.getByRole("log")).toHaveTextContent("setup finished");
  });

  it("shows Cancelling until the authoritative terminal snapshot arrives", async () => {
    const user = userEvent.setup();
    useThreadStartupStore.getState().apply(startup());
    startupTransport.cancelThreadStartup.mockResolvedValue(startup({
      cancellation: "requested",
      revision: 2,
    }));
    render(<StartupCardHarness />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getAllByText("Cancelling…")).not.toHaveLength(0));
    expect(screen.queryByText("Cancelled")).toBeNull();

    useThreadStartupStore.getState().apply(startup({
      state: "cancelled",
      cancellation: "requested",
      phase: "setup",
      revision: 3,
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "worktree", state: "completed" },
        { phase: "setup", state: "cancelled" },
        { phase: "agent", state: "pending" },
      ],
    }));

    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
  });

  it("disables shimmer animation when reduced motion is requested", () => {
    render(<StartupProgressCard startupId={startupId} context="managed-worktree" />);
    expect(screen.getByText("Preparing checkout")).toHaveClass("startup-shimmer-text", "motion-reduce:animate-none");
    expect(screen.getByTestId("startup-activity-icon")).toHaveAttribute("data-slot", "worktree-mode-icon");
  });

  it("removes the startup display after successful completion", () => {
    render(<StartupProgressCard startup={startup({ state: "completed" })} startupId={startupId} context="managed-worktree" />);
    expect(screen.queryByTestId("startup-progress")).toBeNull();
  });
});
