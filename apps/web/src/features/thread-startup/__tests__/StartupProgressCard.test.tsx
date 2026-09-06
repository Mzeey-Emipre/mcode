import type { ThreadStartup } from "@mcode/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
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

  it("keeps provided recovery actions available after failed startup details", async () => {
    const user = userEvent.setup();
    const retrySetup = vi.fn();
    const continueWithoutSetup = vi.fn();
    render(
      <StartupProgressCard
        startup={startup({
          state: "failed",
          steps: [
            { phase: "thread", state: "completed" },
            { phase: "worktree", state: "completed" },
            { phase: "setup", state: "failed" },
            { phase: "agent", state: "pending" },
          ],
          transcript: [{ phase: "setup", content: "setup failed", createdAt: "2026-09-02T12:00:00.000Z" }],
        })}
        startupId={startupId}
        context="managed-worktree"
        actions={(
          <>
            <button type="button" onClick={retrySetup}>Retry setup</button>
            <button type="button" onClick={continueWithoutSetup}>Continue without setup</button>
          </>
        )}
      />,
    );

    await user.click(screen.getByText("More details"));
    const transcript = screen.getByRole("log");
    const actionArea = screen.getByTestId("startup-action-area");
    expect(transcript.compareDocumentPosition(actionArea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Retry setup" }));
    await user.click(screen.getByRole("button", { name: "Continue without setup" }));
    expect(retrySetup).toHaveBeenCalledOnce();
    expect(continueWithoutSetup).toHaveBeenCalledOnce();
  });

  it("uses one animated activity line until cancellation is confirmed", async () => {
    const user = userEvent.setup();
    useThreadStartupStore.getState().apply(startup());
    let resolveCancellation!: (record: ThreadStartup) => void;
    startupTransport.cancelThreadStartup.mockImplementation(() => new Promise((resolve) => {
      resolveCancellation = resolve;
    }));
    render(<StartupCardHarness />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByTestId("startup-activity")).toHaveTextContent("Cancelling setup"));
    expect(screen.getAllByText("Cancelling setup")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("startup-activity-base")).toBeVisible();
    expect(screen.getByTestId("startup-activity-shimmer")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("startup-activity-shimmer")).toHaveClass("startup-activity-shimmer", "motion-reduce:animate-none");
    expect(screen.getAllByText("Cancelling setup")).toHaveLength(1);
    expect(screen.queryByText("Cancelling…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByText("Run project setup").closest("li")).toHaveAttribute("data-state", "running");

    await act(async () => {
      resolveCancellation(startup({ cancellation: "requested", revision: 2 }));
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
    });

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Startup cancelled");
    expect(screen.queryByTestId("startup-activity-shimmer")).toBeNull();
    expect(screen.queryByText("Cancelled")).toBeNull();
    expect(screen.getByText("Run project setup").closest("li")).toHaveAttribute("data-state", "cancelled");
  });

  it("uses one aria-hidden shimmer overlay for active activity", () => {
    render(<StartupProgressCard startupId={startupId} context="managed-worktree" />);
    const activity = screen.getByTestId("startup-activity");
    const base = screen.getByTestId("startup-activity-base");
    const overlay = screen.getByTestId("startup-activity-shimmer");
    expect(activity).toHaveClass("text-sm", "text-muted-foreground");
    expect(base).toBeVisible();
    expect(screen.getByTestId("startup-activity-icon")).toHaveAttribute("data-slot", "worktree-mode-icon");
    expect(screen.getByTestId("startup-activity-icon")).toHaveClass("text-current");
    expect(base.querySelector("span")).toHaveClass("text-current");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(overlay).toHaveClass("text-foreground", "startup-activity-shimmer", "motion-reduce:animate-none");
    expect(screen.getByTestId("startup-activity-shimmer-icon")).toHaveClass("text-current");
    expect(overlay.querySelector("[data-startup-activity-shimmer-text]")).toHaveClass("text-current");
    expect(overlay.querySelector("[data-startup-activity-shimmer-text]")).toHaveAttribute("data-startup-activity-shimmer-text", "Preparing checkout");
    expect(screen.getAllByText("Preparing checkout")).toHaveLength(1);
    expect(screen.getByTestId("startup-progress").querySelector("[aria-busy]")).not.toHaveClass("shadow-sm");
    expect(screen.getByLabelText("Running")).toHaveClass("text-xs");
  });

  it("allows cancellation to be retried until an authoritative terminal snapshot arrives", async () => {
    const user = userEvent.setup();
    useThreadStartupStore.getState().apply(startup());
    startupTransport.cancelThreadStartup
      .mockRejectedValueOnce(new Error("containment failed"))
      .mockResolvedValueOnce(startup({ cancellation: "requested", revision: 2 }));
    render(<StartupCardHarness />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Could not stop project setup")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry cancel" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(startupTransport.cancelThreadStartup).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Could not stop project setup")).toBeNull();
  });

  it("clears a local stop error when the server confirms cancellation", async () => {
    const user = userEvent.setup();
    startupTransport.cancelThreadStartup.mockRejectedValueOnce(new Error("containment failed"));
    const view = render(<StartupProgressCard startup={startup()} startupId={startupId} context="managed-worktree" />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Could not stop project setup")).toBeInTheDocument();

    view.rerender(<StartupProgressCard startup={startup({
      state: "cancelled",
      cancellation: "requested",
      revision: 2,
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "worktree", state: "completed" },
        { phase: "setup", state: "cancelled" },
        { phase: "agent", state: "pending" },
      ],
    })} startupId={startupId} context="managed-worktree" />);

    expect(screen.queryByText("Could not stop project setup")).toBeNull();
  });

  it("removes the startup display after successful completion", () => {
    render(<StartupProgressCard startup={startup({ state: "completed" })} startupId={startupId} context="managed-worktree" />);
    expect(screen.queryByTestId("startup-progress")).toBeNull();
  });
});
