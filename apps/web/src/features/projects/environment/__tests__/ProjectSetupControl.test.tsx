import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentSetupAttempt } from "@mcode/contracts";

const { transport } = vi.hoisted(() => ({
  transport: {
    getWorkspaceSetupAttempt: vi.fn(),
    startWorkspaceSetup: vi.fn(),
  },
}));

vi.mock("@/transport", () => ({ getTransport: () => transport }));

import {
  ProjectSetupAttemptCard,
  ProjectSetupMenu,
  useProjectSetupAttempt,
} from "../ProjectSetupControl";

const failedAttempt: WorkspaceEnvironmentSetupAttempt = {
  id: "attempt-1",
  threadId: "thread-1",
  workspaceId: "workspace-1",
  status: "failed",
  outcome: "command_failure",
  snapshot: {
    platform: "windows",
    script: "bun run setup",
    checkoutPath: "C:\\repo",
    terminal: {
      executable: "pwsh.exe",
      arguments: ["-NoProfile", "-NonInteractive", "-Command", "bun run setup"],
    },
  },
  createdAt: "2026-08-22T12:00:00.000Z",
  startedAt: "2026-08-22T12:00:00.000Z",
  finishedAt: "2026-08-22T12:00:01.000Z",
  exitCode: 2,
  output: "missing dependency",
  outputTruncated: false,
  cleanupPending: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function SetupState({ threadId }: { readonly threadId: string }) {
  const setup = useProjectSetupAttempt(threadId);
  return (
    <>
      <p data-testid="setup-attempt">{setup.attempt?.id ?? "none"}</p>
      <p data-testid="setup-error">{setup.startError ?? "none"}</p>
      <button type="button" onClick={() => { void setup.start(); }}>Start</button>
    </>
  );
}

describe("ProjectSetup controls", () => {
  it("starts Setup through the overview menu", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<ProjectSetupMenu attempt={null} starting={false} onStart={onStart} />);

    const trigger = screen.getByRole("button", { name: "Project Setup actions" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Run Setup" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("disables Run Setup while an attempt is running", async () => {
    const user = userEvent.setup();
    render(<ProjectSetupMenu attempt={{ ...failedAttempt, status: "running", outcome: null, finishedAt: null }} starting={false} onStart={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Project Setup actions" }));
    expect(await screen.findByRole("menuitem", { name: "Run Setup" })).toHaveAttribute("aria-disabled", "true");
  });

  it("disables Run Setup while containment cleanup remains active", async () => {
    const user = userEvent.setup();
    const attempt = { ...failedAttempt, outcome: "containment_failure" as const, cleanupPending: true };
    render(<><ProjectSetupMenu attempt={attempt} starting={false} onStart={vi.fn()} /><ProjectSetupAttemptCard attempt={attempt} /></>);

    await user.click(screen.getByRole("button", { name: "Project Setup actions" }));
    expect(await screen.findByRole("menuitem", { name: "Run Setup" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Setup cleanup is still pending.")).toBeInTheDocument();
  });

  it("exposes status, command, output, exit code, and keyboard-expandable details", async () => {
    const user = userEvent.setup();
    render(<ProjectSetupAttemptCard attempt={failedAttempt} />);

    const trigger = screen.getByRole("button", { name: "Setup Failed. Hide details" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls");
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByLabelText("Setup command")).toHaveTextContent("bun run setup");
    expect(screen.getByLabelText("Setup output")).toHaveTextContent("missing dependency");
    expect(screen.getByText("Exit code: 2")).toBeInTheDocument();

    trigger.focus();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("does not let an initial load overwrite a newer start result", async () => {
    const initial = deferred<WorkspaceEnvironmentSetupAttempt | null>();
    const started = deferred<WorkspaceEnvironmentSetupAttempt>();
    transport.getWorkspaceSetupAttempt.mockImplementationOnce(() => initial.promise);
    transport.startWorkspaceSetup.mockImplementationOnce(() => started.promise);
    render(<SetupState threadId="thread-1" />);

    await waitFor(() => expect(transport.getWorkspaceSetupAttempt).toHaveBeenCalledWith("thread-1"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Start" }));
    await act(async () => { started.resolve({ ...failedAttempt, id: "attempt-new", status: "running", outcome: null, finishedAt: null }); });
    expect(screen.getByTestId("setup-attempt")).toHaveTextContent("attempt-new");

    await act(async () => { initial.resolve({ ...failedAttempt, id: "attempt-old" }); });
    expect(screen.getByTestId("setup-attempt")).toHaveTextContent("attempt-new");
  });

  it("does not apply an old Thread response after the Thread changes", async () => {
    const oldThread = deferred<WorkspaceEnvironmentSetupAttempt | null>();
    const newThread = deferred<WorkspaceEnvironmentSetupAttempt | null>();
    transport.getWorkspaceSetupAttempt.mockImplementationOnce(() => oldThread.promise);
    transport.getWorkspaceSetupAttempt.mockImplementationOnce(() => newThread.promise);
    const view = render(<SetupState threadId="thread-old" />);

    await waitFor(() => expect(transport.getWorkspaceSetupAttempt).toHaveBeenCalledWith("thread-old"));
    view.rerender(<SetupState threadId="thread-new" />);
    expect(screen.getByTestId("setup-attempt")).toHaveTextContent("none");
    await waitFor(() => expect(transport.getWorkspaceSetupAttempt).toHaveBeenCalledWith("thread-new"));
    await act(async () => { newThread.resolve({ ...failedAttempt, id: "attempt-new-thread", threadId: "thread-new" }); });
    expect(screen.getByTestId("setup-attempt")).toHaveTextContent("attempt-new-thread");

    await act(async () => { oldThread.resolve({ ...failedAttempt, id: "attempt-old-thread", threadId: "thread-old" }); });
    expect(screen.getByTestId("setup-attempt")).toHaveTextContent("attempt-new-thread");
  });

  it("does not let an older poll overwrite a newer terminal result", async () => {
    vi.useFakeTimers();
    try {
      transport.getWorkspaceSetupAttempt.mockReset();
      const initial = deferred<WorkspaceEnvironmentSetupAttempt | null>();
      const olderPoll = deferred<WorkspaceEnvironmentSetupAttempt | null>();
      const newerPoll = deferred<WorkspaceEnvironmentSetupAttempt | null>();
      transport.getWorkspaceSetupAttempt.mockImplementationOnce(() => initial.promise);
      transport.getWorkspaceSetupAttempt.mockImplementationOnce(() => olderPoll.promise);
      transport.getWorkspaceSetupAttempt.mockImplementationOnce(() => newerPoll.promise);
      render(<SetupState threadId="thread-1" />);

      await act(async () => { initial.resolve({ ...failedAttempt, id: "attempt-running", status: "running", outcome: null, finishedAt: null, exitCode: null }); });
      await act(async () => { vi.advanceTimersByTime(1_000); });
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(transport.getWorkspaceSetupAttempt).toHaveBeenCalledTimes(3);

      await act(async () => { newerPoll.resolve({ ...failedAttempt, id: "attempt-terminal" }); });
      expect(screen.getByTestId("setup-attempt")).toHaveTextContent("attempt-terminal");
      await act(async () => { olderPoll.resolve({ ...failedAttempt, id: "attempt-older", status: "running", outcome: null, finishedAt: null, exitCode: null }); });
      expect(screen.getByTestId("setup-attempt")).toHaveTextContent("attempt-terminal");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the current attempt and reports a polling failure", async () => {
    vi.useFakeTimers();
    try {
      transport.getWorkspaceSetupAttempt.mockReset();
      const initial = deferred<WorkspaceEnvironmentSetupAttempt | null>();
      transport.getWorkspaceSetupAttempt.mockImplementationOnce(() => initial.promise);
      transport.getWorkspaceSetupAttempt.mockRejectedValueOnce(new Error("offline"));
      render(<SetupState threadId="thread-1" />);

      await act(async () => {
        initial.resolve({ ...failedAttempt, id: "attempt-running", status: "running", outcome: null, finishedAt: null, exitCode: null });
      });
      await act(async () => { vi.advanceTimersByTime(1_000); });

      expect(screen.getByTestId("setup-attempt")).toHaveTextContent("attempt-running");
      expect(screen.getByTestId("setup-error")).toHaveTextContent("Could not refresh Setup status");
    } finally {
      vi.useRealTimers();
    }
  });
});
