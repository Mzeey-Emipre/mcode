import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { InterruptedSessionsBanner } from "./InterruptedSessionsBanner";

describe("InterruptedSessionsBanner", () => {
  const onResume = vi.fn();
  const onDismiss = vi.fn();

  it("renders nothing when threadIds is empty", () => {
    const { container } = render(
      <InterruptedSessionsBanner
        threadIds={[]}
        onResume={onResume}
        onDismiss={onDismiss}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders singular count text for one interrupted session", () => {
    render(
      <InterruptedSessionsBanner
        threadIds={["thread-1"]}
        onResume={onResume}
        onDismiss={onDismiss}
      />,
    );
    expect(
      screen.getByText(/1 session was interrupted during a server restart/i),
    ).toBeInTheDocument();
  });

  it("renders plural count text for multiple interrupted sessions", () => {
    render(
      <InterruptedSessionsBanner
        threadIds={["thread-1", "thread-2", "thread-3"]}
        onResume={onResume}
        onDismiss={onDismiss}
      />,
    );
    expect(
      screen.getByText(/3 sessions were interrupted during a server restart/i),
    ).toBeInTheDocument();
  });

  it("calls onResume with all threadIds when Resume all is clicked", async () => {
    const user = userEvent.setup();
    const mockResume = vi.fn();
    render(
      <InterruptedSessionsBanner
        threadIds={["thread-1", "thread-2"]}
        onResume={mockResume}
        onDismiss={onDismiss}
      />,
    );
    await user.click(screen.getByRole("button", { name: /resume all/i }));
    expect(mockResume).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledWith(["thread-1", "thread-2"]);
  });

  it("shows Resuming... state after clicking Resume all", async () => {
    const user = userEvent.setup();
    render(
      <InterruptedSessionsBanner
        threadIds={["thread-1"]}
        onResume={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    await user.click(screen.getByRole("button", { name: /resume all/i }));
    expect(screen.getByRole("button", { name: /resuming/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /resume all/i })).toBeNull();
  });

  it("calls onDismiss when X button is clicked", async () => {
    const user = userEvent.setup();
    const mockDismiss = vi.fn();
    render(
      <InterruptedSessionsBanner
        threadIds={["thread-1"]}
        onResume={onResume}
        onDismiss={mockDismiss}
      />,
    );
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(mockDismiss).toHaveBeenCalledOnce();
  });
});
