import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { InterruptedSessionsBanner } from "./InterruptedSessionsBanner";

describe("InterruptedSessionsBanner", () => {
  const onRetry = vi.fn();
  const onDismiss = vi.fn();

  it("renders nothing when threadIds is empty", () => {
    const { container } = render(
      <InterruptedSessionsBanner
        threadIds={[]}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders singular count text for one interrupted session", () => {
    render(
      <InterruptedSessionsBanner
        threadIds={["thread-1"]}
        onRetry={onRetry}
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
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    );
    expect(
      screen.getByText(/3 sessions were interrupted during a server restart/i),
    ).toBeInTheDocument();
  });

  it("calls onRetry with all threadIds when Retry all is clicked", async () => {
    const user = userEvent.setup();
    const mockRetry = vi.fn();
    render(
      <InterruptedSessionsBanner
        threadIds={["thread-1", "thread-2"]}
        onRetry={mockRetry}
        onDismiss={onDismiss}
      />,
    );
    await user.click(screen.getByRole("button", { name: /retry all/i }));
    expect(mockRetry).toHaveBeenCalledOnce();
    expect(mockRetry).toHaveBeenCalledWith(["thread-1", "thread-2"]);
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
  });

  it("shows Retry state after clicking Retry all", async () => {
    const user = userEvent.setup();
    render(
      <InterruptedSessionsBanner
        threadIds={["thread-1"]}
        onRetry={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    await user.click(screen.getByRole("button", { name: /retry all/i }));
    expect(screen.getByRole("button", { name: /retrying/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /retry all/i })).toBeNull();
  });

  it("calls onDismiss when X button is clicked", async () => {
    const user = userEvent.setup();
    const mockDismiss = vi.fn();
    render(
      <InterruptedSessionsBanner
        threadIds={["thread-1"]}
        onRetry={onRetry}
        onDismiss={mockDismiss}
      />,
    );
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(mockDismiss).toHaveBeenCalledOnce();
  });
});
