import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentAutomaticSetupSnapshot } from "@mcode/contracts";

const { transport, removePersistedMessage } = vi.hoisted(() => ({
  transport: {
    getAutomaticSetup: vi.fn(),
    continueAutomaticSetup: vi.fn(),
    cancelQueuedAutomaticTurn: vi.fn(),
  },
  removePersistedMessage: vi.fn(),
}));

vi.mock("@/transport", () => ({ getTransport: () => transport }));
vi.mock("@/stores/threadStore", () => ({
  useThreadStore: { getState: () => ({ removePersistedMessage }) },
}));

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
  queuedTurn: {
    id: "submission-1",
    messageId: "message-1",
    state: "queued",
    createdAt: "2026-08-22T12:00:00.000Z",
    dispatchedAt: null,
  },
};

function AutomaticSetupState({ isManagedNewWorktree = true }: { readonly isManagedNewWorktree?: boolean }) {
  const automaticSetup = useProjectAutomaticSetup("thread-1", isManagedNewWorktree);
  return (
    <ProjectAutomaticSetupCard
      snapshot={automaticSetup.snapshot}
      busy={automaticSetup.busy}
      error={automaticSetup.error}
      onContinue={automaticSetup.continueWithoutSetup}
      onCancel={automaticSetup.cancelQueuedTurn}
    />
  );
}

describe("ProjectAutomaticSetupControl", () => {
  it("announces a blocked first Turn with accessible Continue and cancel controls", async () => {
    transport.getAutomaticSetup.mockResolvedValue(blocked);
    render(<AutomaticSetupState />);

    expect(await screen.findByRole("button", { name: /Automatic Setup. Setup failed. Hide details/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("first Turn remains queued");
    expect(screen.getByLabelText("Automatic Setup command")).toHaveTextContent("bun run setup");
    expect(screen.getByLabelText("Automatic Setup output")).toHaveTextContent("missing dependency");
    expect(screen.getByText("Result: Command exited with an error.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue without Setup" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel queued Turn" })).toBeEnabled();
  });

  it("releases the queued Turn without requesting another Setup run", async () => {
    const user = userEvent.setup();
    transport.getAutomaticSetup.mockResolvedValue(blocked);
    transport.continueAutomaticSetup.mockResolvedValue({
      ...blocked,
      gate: "released-by-continue",
      queuedTurn: { ...blocked.queuedTurn!, state: "dispatched", dispatchedAt: "2026-08-22T12:00:02.000Z" },
    });
    render(<AutomaticSetupState />);

    await user.click(await screen.findByRole("button", { name: "Continue without Setup" }));

    expect(transport.continueAutomaticSetup).toHaveBeenCalledWith("thread-1");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("was dispatched"));
  });

  it("cancels only the queued Turn and reports that Setup was not stopped", async () => {
    const user = userEvent.setup();
    transport.getAutomaticSetup.mockResolvedValue(blocked);
    transport.cancelQueuedAutomaticTurn.mockResolvedValue({
      ...blocked,
      queuedTurn: { ...blocked.queuedTurn!, state: "cancelled" },
    });
    render(<AutomaticSetupState />);

    await user.click(await screen.findByRole("button", { name: "Cancel queued Turn" }));

    expect(transport.cancelQueuedAutomaticTurn).toHaveBeenCalledWith("thread-1");
    expect(removePersistedMessage).toHaveBeenCalledWith("thread-1", "message-1");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Setup was not stopped"));
  });

  it("keeps an uncertain no-Setup dispatch visible without offering a retry", () => {
    render(
      <ProjectAutomaticSetupCard
        snapshot={{
          gate: "not-required",
          attempt: null,
          queuedTurn: {
            id: "submission-1",
            messageId: "message-1",
            state: "dispatching",
            createdAt: "2026-08-22T12:00:00.000Z",
            dispatchedAt: null,
          },
        }}
        busy={null}
        error={null}
        onContinue={async () => undefined}
        onCancel={async () => undefined}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("claimed for dispatch");
    expect(screen.queryByRole("button", { name: "Continue without Setup" })).not.toBeInTheDocument();
  });

  it("polls a released or dispatching first Turn until dispatch reaches its stable state", async () => {
    vi.useFakeTimers();
    try {
      transport.getAutomaticSetup.mockReset();
      transport.getAutomaticSetup
        .mockResolvedValueOnce({
          ...blocked,
          attempt: { ...blocked.attempt, state: "passed", reason: null, outcome: "success", exitCode: 0, output: "done" },
          queuedTurn: { ...blocked.queuedTurn!, state: "dispatching" },
        })
        .mockResolvedValueOnce({
          ...blocked,
          attempt: { ...blocked.attempt, state: "passed", reason: null, outcome: "success", exitCode: 0, output: "done" },
          queuedTurn: { ...blocked.queuedTurn!, state: "dispatched", dispatchedAt: "2026-08-22T12:00:02.000Z" },
        });
      render(<AutomaticSetupState />);

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(screen.getByRole("status")).toHaveTextContent("claimed for dispatch");
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

      expect(transport.getAutomaticSetup).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("status")).toHaveTextContent("was dispatched");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the initial managed-New hydration until the committed Setup gate becomes visible", async () => {
    vi.useFakeTimers();
    try {
      const running: WorkspaceEnvironmentAutomaticSetupSnapshot = {
        ...blocked,
        attempt: {
          id: "attempt-1",
          state: "running",
          reason: null,
          snapshot: {
            platform: "windows",
            script: "bun run setup",
            checkoutPath: "C:\\repo",
            terminal: { executable: "pwsh.exe", arguments: ["-Command", "bun run setup"] },
          },
          outcome: null,
          createdAt: "2026-08-22T12:00:00.000Z",
          startedAt: "2026-08-22T12:00:00.000Z",
          finishedAt: null,
          exitCode: null,
          output: "",
          outputTruncated: false,
        },
      };
      transport.getAutomaticSetup.mockReset();
      transport.getAutomaticSetup
        .mockResolvedValueOnce({ gate: "not-required", attempt: null, queuedTurn: null })
        .mockResolvedValue(running);
      render(<AutomaticSetupState />);

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(screen.queryByRole("button", { name: /Automatic Setup/i })).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });

      expect(screen.getByRole("button", { name: /Automatic Setup. Setup running/i })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(transport.getAutomaticSetup).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops initial retry after a bounded empty lifecycle window", async () => {
    vi.useFakeTimers();
    try {
      transport.getAutomaticSetup.mockReset();
      transport.getAutomaticSetup.mockResolvedValue({ gate: "not-required", attempt: null, queuedTurn: null });
      render(<AutomaticSetupState />);

      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(transport.getAutomaticSetup).toHaveBeenCalledTimes(11);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(transport.getAutomaticSetup).toHaveBeenCalledTimes(11);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a non-managed Thread with no automatic lifecycle", async () => {
    vi.useFakeTimers();
    try {
      transport.getAutomaticSetup.mockReset();
      transport.getAutomaticSetup.mockResolvedValue({ gate: "not-required", attempt: null, queuedTurn: null });
      render(<AutomaticSetupState isManagedNewWorktree={false} />);

      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(transport.getAutomaticSetup).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
