import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentAutomaticSetupSnapshot } from "@mcode/contracts";
import { ProjectAutomaticSetupCard, useProjectAutomaticSetup } from "../ProjectAutomaticSetupControl";

const transport = vi.hoisted(() => ({
  getAutomaticSetup: vi.fn(),
  continueAutomaticSetup: vi.fn(),
  retryAutomaticSetup: vi.fn(),
  approveWorkspaceEnvironmentCommand: vi.fn(),
}));

vi.mock("@/transport", () => ({ getTransport: () => transport }));

const failed: WorkspaceEnvironmentAutomaticSetupSnapshot = {
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
  }],
};

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("ProjectAutomaticSetupControl", () => {
  it("shows the failed script and output with only the two recovery actions", async () => {
    const retry = vi.fn();
    const continueWithoutSetup = vi.fn();
    const user = userEvent.setup();

    render(
      <ProjectAutomaticSetupCard
        snapshot={failed}
        busy={null}
        error={null}
        onRetry={async () => { retry(); }}
        onContinue={async () => { continueWithoutSetup(); }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Environment setup failed" })).toBeVisible();
    expect(screen.getByText("Choose how to continue this thread.")).toBeVisible();
    expect(screen.getByLabelText("Environment setup terminal")).toHaveTextContent("$ bun run setup");
    expect(screen.getByLabelText("Environment setup terminal")).toHaveTextContent("missing dependency");
    expect(screen.queryByRole("button", { name: "Open terminal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel queued Turn/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry setup" }));
    await user.click(screen.getByRole("button", { name: "Continue without setup" }));

    expect(retry).toHaveBeenCalledOnce();
    expect(continueWithoutSetup).toHaveBeenCalledOnce();
  });

  it("removes the setup view after the gate releases", () => {
    render(
      <ProjectAutomaticSetupCard
        snapshot={{ ...failed, gate: "released-by-pass" }}
        busy={null}
        error={null}
        onRetry={async () => undefined}
        onContinue={async () => undefined}
      />,
    );

    expect(screen.queryByLabelText("Environment setup")).not.toBeInTheDocument();
    expect(screen.queryByText("Setup passed")).not.toBeInTheDocument();
    expect(screen.queryByText("Setup skipped")).not.toBeInTheDocument();
  });

  it("releases the first turn and clears the setup view when the user continues", async () => {
    const user = userEvent.setup();
    transport.getAutomaticSetup.mockResolvedValue(failed);
    transport.continueAutomaticSetup.mockResolvedValue({ ...failed, gate: "released-by-continue" });

    function Setup() {
      const automaticSetup = useProjectAutomaticSetup("thread-1");
      return <ProjectAutomaticSetupCard snapshot={automaticSetup.snapshot} busy={automaticSetup.busy} error={automaticSetup.error} onRetry={automaticSetup.retrySetup} onContinue={automaticSetup.continueWithoutSetup} />;
    }

    render(<Setup />);
    await user.click(await screen.findByRole("button", { name: "Continue without setup" }));

    expect(transport.continueAutomaticSetup).toHaveBeenCalledWith("thread-1");
    await waitFor(() => expect(screen.queryByLabelText("Environment setup")).not.toBeInTheDocument());
  });

  it("refreshes a running setup so its terminal output stays current", async () => {
    vi.useFakeTimers();
    transport.getAutomaticSetup
      .mockResolvedValueOnce({
        ...failed,
        attempt: { ...failed.attempt!, state: "running", reason: null, outcome: null, finishedAt: null, exitCode: null, output: "installing dependencies" },
      })
      .mockResolvedValueOnce({
        ...failed,
        attempt: { ...failed.attempt!, state: "running", reason: null, outcome: null, finishedAt: null, exitCode: null, output: "running project bootstrap" },
      });

    function Setup() {
      const automaticSetup = useProjectAutomaticSetup("thread-1");
      return (
        <ProjectAutomaticSetupCard
          snapshot={automaticSetup.snapshot}
          busy={automaticSetup.busy}
          error={automaticSetup.error}
          onRetry={automaticSetup.retrySetup}
          onContinue={automaticSetup.continueWithoutSetup}
        />
      );
    }

    render(<Setup />);

    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("heading", { name: "Setting up environment" })).toBeVisible();
    expect(screen.getByText("installing dependencies")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText("running project bootstrap")).toBeInTheDocument();
  });
});
