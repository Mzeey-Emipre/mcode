import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentAutomaticSetupSnapshot } from "@mcode/contracts";

const { transport, removePersistedMessage, addTerminal, addRightPanelTerminalTab, showRightPanelAdaptive } = vi.hoisted(() => ({
  transport: {
    getAutomaticSetup: vi.fn(),
    continueAutomaticSetup: vi.fn(),
    cancelQueuedAutomaticTurn: vi.fn(),
    stopAutomaticSetup: vi.fn(),
    retryAutomaticSetup: vi.fn(),
    repairAutomaticSetup: vi.fn(),
    openAutomaticSetupTerminal: vi.fn(),
  },
  removePersistedMessage: vi.fn(),
  addTerminal: vi.fn(),
  addRightPanelTerminalTab: vi.fn(),
  showRightPanelAdaptive: vi.fn(),
}));

vi.mock("@/transport", () => ({ getTransport: () => transport }));
vi.mock("@/stores/threadStore", () => ({
  useThreadStore: { getState: () => ({ removePersistedMessage }) },
}));
vi.mock("@/features/terminal/state/terminalStore", () => ({
  useTerminalStore: { getState: () => ({ addTerminal }) },
}));
vi.mock("@/stores/diffStore", () => ({
  useDiffStore: { getState: () => ({ addRightPanelTerminalTab }) },
}));
vi.mock("@/lib/right-panel-layout", () => ({ showRightPanelAdaptive }));

import { ProjectAutomaticSetupCard, useProjectAutomaticSetup } from "../ProjectAutomaticSetupControl";

const blocked: WorkspaceEnvironmentAutomaticSetupSnapshot = {
  gate: "blocked",
  attempt: {
    id: "attempt-1",
    state: "failed",
    reason: "setup_failed",
    snapshot: {
      platform: "windows",
      script: "bun run setup",
      checkoutPath: "C:\\repo",
      terminal: { executable: "pwsh.exe", arguments: ["-Command", "bun run setup"] },
    },
    outcome: "command_failure",
    createdAt: "2026-08-22T12:00:00.000Z",
    startedAt: "2026-08-22T12:00:00.000Z",
    finishedAt: "2026-08-22T12:00:01.000Z",
    exitCode: 1,
    output: "missing dependency",
    outputTruncated: false,
  },
  queuedTurns: [{
    id: "submission-1",
    messageId: "message-1",
    state: "queued",
    createdAt: "2026-08-22T12:00:00.000Z",
    dispatchedAt: null,
  }, {
    id: "submission-2",
    messageId: "message-2",
    state: "queued",
    createdAt: "2026-08-22T12:00:01.000Z",
    dispatchedAt: null,
  }],
};

function AutomaticSetupState() {
  const automaticSetup = useProjectAutomaticSetup("thread-1", "workspace-1");
  return (
    <ProjectAutomaticSetupCard
      snapshot={automaticSetup.snapshot}
      busy={automaticSetup.busy}
      error={automaticSetup.error}
      onContinue={automaticSetup.continueWithoutSetup}
      onCancel={automaticSetup.cancelQueuedTurn}
      onStop={automaticSetup.stopSetup}
      onRetry={automaticSetup.retrySetup}
      onRepair={automaticSetup.repairSetup}
      onOpenTerminal={automaticSetup.openRecoveryTerminal}
    />
  );
}

async function showAutomaticSetupDetails() {
  fireEvent.click(await screen.findByRole("button", { name: /Show details/i }));
}

describe("ProjectAutomaticSetupControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.getAutomaticSetup.mockResolvedValue(blocked);
  });

  it("renders ordered queued Turns and joined keyboard-accessible recovery controls", async () => {
    const retry = vi.fn();
    const repair = vi.fn();
    const terminal = vi.fn();
    const user = userEvent.setup();
    render(
      <ProjectAutomaticSetupCard
        snapshot={blocked}
        busy={null}
        error={null}
        onContinue={async () => undefined}
        onCancel={async () => undefined}
        onStop={async () => undefined}
        onRetry={async () => { retry(); }}
        onRepair={async () => { repair(); }}
        onOpenTerminal={async () => { terminal(); }}
      />,
    );

    const disclosure = screen.getByRole("button", { name: /Automatic Setup. Setup failed. Show details/i });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("region").firstElementChild).toHaveClass("hidden");

    await user.click(disclosure);

    expect(screen.getByRole("button", { name: /Automatic Setup. Setup failed. Hide details/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region").firstElementChild).not.toHaveClass("hidden");
    expect(screen.getByRole("status")).toHaveTextContent("2 queued Turns remain blocked");
    expect(screen.getByLabelText("Automatic Setup command")).toHaveTextContent("bun run setup");
    expect(screen.getByRole("button", { name: "Fix with agent" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "More automatic Setup recovery options" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel queued Turn 1" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel queued Turn 2" })).toBeEnabled();

    screen.getByRole("button", { name: "More automatic Setup recovery options" }).focus();
    await user.keyboard("{Enter}");
    const retryFromMenu = await screen.findByRole("menuitem", { name: "Retry setup" });
    expect(retryFromMenu).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    const openTerminal = await screen.findByRole("menuitem", { name: "Open terminal" });
    expect(openTerminal).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(terminal).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it("cancels only the selected queued Turn and removes its matching message", async () => {
    const user = userEvent.setup();
    transport.cancelQueuedAutomaticTurn.mockResolvedValue({
      ...blocked,
      queuedTurns: [{ ...blocked.queuedTurns[0]!, state: "cancelled" }, blocked.queuedTurns[1]!],
    });
    render(<AutomaticSetupState />);
    await showAutomaticSetupDetails();

    await user.click(await screen.findByRole("button", { name: "Cancel queued Turn 1" }));

    expect(transport.cancelQueuedAutomaticTurn).toHaveBeenCalledWith("thread-1", "submission-1");
    expect(removePersistedMessage).toHaveBeenCalledWith("thread-1", "message-1");
    expect(removePersistedMessage).not.toHaveBeenCalledWith("thread-1", "message-2");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 queued Turn remains blocked"));
  });

  it("announces an active repair and suppresses duplicate recovery controls", async () => {
    render(
      <ProjectAutomaticSetupCard
        snapshot={{
          ...blocked,
          repair: {
            id: "repair-1",
            failedAttemptId: "attempt-1",
            state: "repairing",
            createdAt: "2026-08-22T12:00:02.000Z",
            finishedAt: null,
          },
        }}
        busy={null}
        error={null}
        onContinue={async () => undefined}
        onCancel={async () => undefined}
        onStop={async () => undefined}
        onRetry={async () => undefined}
        onRepair={async () => undefined}
        onOpenTerminal={async () => undefined}
      />,
    );
    await showAutomaticSetupDetails();

    expect(screen.getByRole("button", { name: /Automatic Setup. Repairing Setup/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("A repair Turn is running before Setup reruns.");
    expect(screen.queryByRole("button", { name: "Fix with agent" })).not.toBeInTheDocument();
  });

  it("offers Setup retry after the failed attempt already used its repair cycle", async () => {
    render(
      <ProjectAutomaticSetupCard
        snapshot={{
          ...blocked,
          repair: {
            id: "repair-1",
            failedAttemptId: "attempt-1",
            state: "failed",
            createdAt: "2026-08-22T12:00:02.000Z",
            finishedAt: "2026-08-22T12:00:03.000Z",
          },
        }}
        busy={null}
        error={null}
        onContinue={async () => undefined}
        onCancel={async () => undefined}
        onStop={async () => undefined}
        onRetry={async () => undefined}
        onRepair={async () => undefined}
        onOpenTerminal={async () => undefined}
      />,
    );
    await showAutomaticSetupDetails();

    expect(screen.getByRole("button", { name: "Retry setup" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Fix with agent" })).not.toBeInTheDocument();
  });

  it("keeps a message visible when the server could no longer cancel its Turn", async () => {
    const user = userEvent.setup();
    transport.cancelQueuedAutomaticTurn.mockResolvedValue({
      ...blocked,
      gate: "released-by-continue",
      queuedTurns: [{ ...blocked.queuedTurns[0]!, state: "released" }, blocked.queuedTurns[1]!],
    });
    render(<AutomaticSetupState />);
    await showAutomaticSetupDetails();

    await user.click(await screen.findByRole("button", { name: "Cancel queued Turn 1" }));

    expect(transport.cancelQueuedAutomaticTurn).toHaveBeenCalledWith("thread-1", "submission-1");
    expect(removePersistedMessage).not.toHaveBeenCalled();
  });

  it("keeps Stop separate while Setup runs and preserves the blocked gate after stopping", async () => {
    const user = userEvent.setup();
    const running: WorkspaceEnvironmentAutomaticSetupSnapshot = {
      ...blocked,
      attempt: { ...blocked.attempt!, state: "running", reason: null, outcome: null, finishedAt: null, exitCode: null, output: "" },
    };
    transport.getAutomaticSetup.mockResolvedValue(running);
    transport.stopAutomaticSetup.mockResolvedValue({
      ...blocked,
      attempt: { ...blocked.attempt!, state: "interrupted", reason: "setup_interrupted", outcome: null, exitCode: null, output: "", outputTruncated: false },
    });
    render(<AutomaticSetupState />);
    await showAutomaticSetupDetails();

    await user.click(await screen.findByRole("button", { name: "Stop setup" }));

    expect(transport.stopAutomaticSetup).toHaveBeenCalledWith("thread-1");
    await waitFor(() => expect(screen.getByRole("button", { name: /Automatic Setup. Setup interrupted/i })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Retry setup" })).toBeInTheDocument();
  });

  it("keeps Stop available after every queued Turn was cancelled", async () => {
    const user = userEvent.setup();
    const runningWithoutQueuedTurns: WorkspaceEnvironmentAutomaticSetupSnapshot = {
      ...blocked,
      attempt: { ...blocked.attempt!, state: "running", reason: null, outcome: null, finishedAt: null, exitCode: null, output: "" },
      queuedTurns: [],
    };
    transport.getAutomaticSetup.mockResolvedValue(runningWithoutQueuedTurns);
    transport.stopAutomaticSetup.mockResolvedValue({
      ...runningWithoutQueuedTurns,
      attempt: { ...blocked.attempt!, state: "interrupted", reason: "setup_interrupted", outcome: null, exitCode: null, output: "", outputTruncated: false },
    });
    render(<AutomaticSetupState />);
    await showAutomaticSetupDetails();

    await user.click(await screen.findByRole("button", { name: "Stop setup" }));

    expect(transport.stopAutomaticSetup).toHaveBeenCalledWith("thread-1");
    await waitFor(() => expect(screen.getByRole("button", { name: /Automatic Setup. Setup interrupted/i })).toBeInTheDocument());
  });

  it("keeps recovery actions available after the last queued Turn is cancelled", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const repair = vi.fn();
    const terminal = vi.fn();
    const continueWithoutSetup = vi.fn();
    render(
      <ProjectAutomaticSetupCard
        snapshot={{ ...blocked, queuedTurns: [] }}
        busy={null}
        error={null}
        onContinue={async () => { continueWithoutSetup(); }}
        onCancel={async () => undefined}
        onStop={async () => undefined}
        onRetry={async () => { retry(); }}
        onRepair={async () => { repair(); }}
        onOpenTerminal={async () => { terminal(); }}
      />,
    );
    await showAutomaticSetupDetails();

    await user.click(screen.getByRole("button", { name: "Fix with agent" }));
    await user.click(screen.getByRole("button", { name: "More automatic Setup recovery options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Retry setup" }));
    await user.click(screen.getByRole("button", { name: "More automatic Setup recovery options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Open terminal" }));
    await user.click(screen.getByRole("button", { name: "More automatic Setup recovery options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Continue without setup" }));

    expect(retry).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledOnce();
    expect(continueWithoutSetup).toHaveBeenCalledOnce();
  });

  it("opens a separate recovery Terminal without releasing the gate", async () => {
    const user = userEvent.setup();
    transport.openAutomaticSetupTerminal.mockResolvedValue({ ptyId: "recovery-pty", shell: "pwsh" });
    render(<AutomaticSetupState />);
    await showAutomaticSetupDetails();

    await user.click(await screen.findByRole("button", { name: "More automatic Setup recovery options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Open terminal" }));

    expect(transport.openAutomaticSetupTerminal).toHaveBeenCalledWith("thread-1");
    expect(addTerminal).toHaveBeenCalledWith("thread-1", "recovery-pty", "pwsh");
    expect(showRightPanelAdaptive).toHaveBeenCalledWith("workspace-1", "thread-1");
    expect(addRightPanelTerminalTab).toHaveBeenCalledWith("workspace-1", "thread-1", "recovery-pty");
    expect(transport.continueAutomaticSetup).not.toHaveBeenCalled();
  });

  it("keeps an uncertain no-Setup dispatch visible without offering recovery controls", async () => {
    render(
      <ProjectAutomaticSetupCard
        snapshot={{
          gate: "not-required",
          attempt: null,
          queuedTurns: [{
            id: "submission-1",
            messageId: "message-1",
            state: "dispatching",
            createdAt: "2026-08-22T12:00:00.000Z",
            dispatchedAt: null,
          }],
        }}
        busy={null}
        error={null}
        onContinue={async () => undefined}
        onCancel={async () => undefined}
        onStop={async () => undefined}
        onRetry={async () => undefined}
        onRepair={async () => undefined}
        onOpenTerminal={async () => undefined}
      />,
    );
    await showAutomaticSetupDetails();

    expect(screen.getByRole("status")).toHaveTextContent("claimed for dispatch");
    expect(screen.queryByRole("button", { name: "Retry setup" })).not.toBeInTheDocument();
  });

  it("keeps a continued gate distinct from Setup success after every Turn dispatches", async () => {
    render(
      <ProjectAutomaticSetupCard
        snapshot={{
          ...blocked,
          gate: "released-by-continue",
          queuedTurns: blocked.queuedTurns.map((queuedTurn, index) => ({
            ...queuedTurn,
            state: "dispatched",
            dispatchedAt: `2026-08-22T12:00:0${index + 2}.000Z`,
          })),
        }}
        busy={null}
        error={null}
        onContinue={async () => undefined}
        onCancel={async () => undefined}
        onStop={async () => undefined}
        onRetry={async () => undefined}
        onRepair={async () => undefined}
        onOpenTerminal={async () => undefined}
      />,
    );
    await showAutomaticSetupDetails();

    expect(screen.getByRole("button", { name: /Automatic Setup. Continued/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Queued Turns were released without recording that Setup passed.");
    expect(screen.queryByRole("button", { name: /Automatic Setup. Turns dispatched/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Automatic Setup. Setup passed/i })).not.toBeInTheDocument();
  });

  it("polls released Turns until dispatch reaches its stable state", async () => {
    vi.useFakeTimers();
    try {
      transport.getAutomaticSetup
        .mockResolvedValueOnce({
          ...blocked,
          attempt: { ...blocked.attempt!, state: "passed", reason: null, outcome: "success", exitCode: 0, output: "done" },
          queuedTurns: [{ ...blocked.queuedTurns[0]!, state: "dispatching" }, blocked.queuedTurns[1]!],
        })
        .mockResolvedValueOnce({
          ...blocked,
          attempt: { ...blocked.attempt!, state: "passed", reason: null, outcome: "success", exitCode: 0, output: "done" },
          queuedTurns: [{ ...blocked.queuedTurns[0]!, state: "dispatched", dispatchedAt: "2026-08-22T12:00:02.000Z" }, { ...blocked.queuedTurns[1]!, state: "dispatched", dispatchedAt: "2026-08-22T12:00:03.000Z" }],
        });
      render(<AutomaticSetupState />);

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      fireEvent.click(screen.getByRole("button", { name: /Show details/i }));
      expect(screen.getByRole("status")).toHaveTextContent("claimed for dispatch");
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

      expect(transport.getAutomaticSetup).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: /Automatic Setup. Turns dispatched/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
