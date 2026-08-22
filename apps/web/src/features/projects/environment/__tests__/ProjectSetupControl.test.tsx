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

  it("renders the accepted icon-led Setup status states without a badge", async () => {
    const passed = render(<ProjectSetupAttemptCard attempt={{ ...failedAttempt, status: "passed", outcome: "success", exitCode: 0 }} />);
    await act(async () => { await Promise.resolve(); });
    const passedHeader = screen.getByRole("button", { name: "Setup Passed. Show details" });
    expect(passedHeader.querySelector(".lucide-circle-check")).toHaveClass("text-[var(--diff-add-strong)]");
    expect(screen.queryByText("Passed")).not.toBeInTheDocument();
    expect(passedHeader.querySelector("[class*='group/badge']")).toBeNull();
    passed.unmount();

    const running = render(<ProjectSetupAttemptCard attempt={{ ...failedAttempt, status: "running", outcome: null, finishedAt: null, exitCode: null }} />);
    await act(async () => { await Promise.resolve(); });
    const runningHeader = screen.getByRole("button", { name: "Setup Running. Hide details" });
    expect(runningHeader.querySelector(".spinner-tail-fade")).toBeInTheDocument();
    expect(screen.getByText("Setup running")).toHaveClass("sr-only");
    expect(screen.queryByText(/^Running$/)).not.toBeInTheDocument();
    expect(runningHeader.querySelector("[class*='group/badge']")).toBeNull();
    running.unmount();

    render(<ProjectSetupAttemptCard attempt={failedAttempt} />);
    await act(async () => { await Promise.resolve(); });
    const failedHeader = screen.getByRole("button", { name: "Setup Failed. Hide details" });
    expect(failedHeader.querySelector(".lucide-octagon-x")).toBeInTheDocument();
    expect(screen.getByText("failed")).toHaveClass("bg-[var(--diff-remove)]/15", "text-[var(--diff-remove)]");
    expect(failedHeader.querySelector("[class*='group/badge']")).toBeNull();
  });

  it("exposes status, command, output, exit code, and keyboard-expandable details", async () => {
    const user = userEvent.setup();
    const tabularOutput = "Mode\tLastWriteTime\tLength\tName\n----\t-------------\t------\t----\nd----\t22/08/2026\t\tproject";
    const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
    const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
    const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(284);
    const scrollWidth = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("aria-label") === "Setup output" ? 837 : 284;
    });
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(160);
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(160);
    class ResizeObserverMock {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverMock });
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
    let unmount: (() => void) | undefined;
    try {
      ({ unmount } = render(<ProjectSetupAttemptCard attempt={{ ...failedAttempt, output: tabularOutput }} />));

      const trigger = screen.getByRole("button", { name: "Setup Failed. Hide details" });
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(trigger).toHaveAttribute("aria-controls");
      expect(screen.getByText("failed")).toBeInTheDocument();
      const command = screen.getByLabelText("Setup command");
      const output = screen.getByLabelText("Setup output");
      expect(command).toHaveTextContent("bun run setup");
      expect(output.querySelector("pre")?.textContent).toBe(tabularOutput);
      expect(command.querySelector("pre")).toHaveClass("whitespace-pre-wrap", "break-words");
      expect(output.querySelector("pre")).toHaveClass("min-w-max", "whitespace-pre");
      expect(output.querySelector("pre")).not.toHaveClass("whitespace-pre-wrap", "break-all");
      const commandScrollArea = command.closest('[data-slot="scroll-area"]');
      const outputScrollArea = output.closest('[data-slot="scroll-area"]');
      expect(outputScrollArea).toHaveClass("overflow-hidden", "flex", "flex-col");
      expect(outputScrollArea).not.toHaveClass("pb-2.5");
      expect(outputScrollArea).not.toHaveClass("max-h-40");
      expect(output).toHaveClass("min-h-0", "flex-1", "max-h-40");
      expect(commandScrollArea).not.toHaveClass("flex", "flex-col");
      expect(commandScrollArea).toHaveClass("max-h-40");
      expect(command).toHaveClass("size-full");
      expect(command).not.toHaveClass("max-h-40");
      await waitFor(() => expect(outputScrollArea?.querySelector('[data-slot="scroll-area-scrollbar"][data-orientation="horizontal"]')).not.toBeNull());
      const outputHorizontalScrollbar = outputScrollArea?.querySelector('[data-slot="scroll-area-scrollbar"][data-orientation="horizontal"]') as HTMLElement;
      expect(outputHorizontalScrollbar).toHaveClass("data-horizontal:h-2.5", "w-full", "shrink-0");
      expect(outputHorizontalScrollbar).toHaveStyle({ position: "relative" });
      expect(outputHorizontalScrollbar.style.bottom).toBe("");
      expect(commandScrollArea?.querySelector('[data-slot="scroll-area-scrollbar"][data-orientation="horizontal"]')).toBeNull();
      expect(screen.getByText("Exit code: 2")).toBeInTheDocument();

      trigger.focus();
      await user.keyboard("{Enter}");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    } finally {
      unmount?.();
      clientWidth.mockRestore();
      scrollWidth.mockRestore();
      clientHeight.mockRestore();
      scrollHeight.mockRestore();
      if (originalResizeObserver) Object.defineProperty(globalThis, "ResizeObserver", originalResizeObserver);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
      if (originalGetAnimations) Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
      else Reflect.deleteProperty(Element.prototype, "getAnimations");
    }
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
