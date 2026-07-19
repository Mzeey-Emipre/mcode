import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { NarrativeIndicator } from "../NarrativeIndicator";

/**
 * Exit-lifecycle coverage for issue #695: the indicator must animate out when
 * the turn ends instead of vanishing in a single frame, must stop rendering
 * after the exit completes, and must not replay the exit on a fresh mount for
 * an already-finished turn.
 */
describe("NarrativeIndicator exit lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderRunning() {
    return render(
      <NarrativeIndicator
        stepCount={3}
        subagentCount={0}
        activeToolCalls={[]}
        startTime={Date.now()}
        isAgentRunning
      />,
    );
  }

  it("renders the status line while the agent is running", () => {
    renderRunning();
    const bar = screen.getByText(/3 steps/).closest("[data-state]");
    expect(bar?.getAttribute("data-state")).toBe("running");
  });

  it("plays the exit transition when the agent stops, then renders nothing", () => {
    const { rerender, container } = renderRunning();

    rerender(
      <NarrativeIndicator
        stepCount={3}
        subagentCount={0}
        activeToolCalls={[]}
        startTime={Date.now()}
        isAgentRunning={false}
      />,
    );

    const exiting = container.querySelector('[data-state="exiting"]');
    expect(exiting).not.toBeNull();
    expect(exiting?.classList.contains("narrative-indicator-exit")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector("[data-state]")).toBeNull();
  });

  it("renders nothing when mounted with the agent already stopped", () => {
    const { container } = render(
      <NarrativeIndicator
        stepCount={3}
        subagentCount={0}
        activeToolCalls={[]}
        startTime={Date.now()}
        isAgentRunning={false}
      />,
    );
    expect(container.querySelector("[data-state]")).toBeNull();
  });

  it("returns to the running state when a new turn starts mid-exit", () => {
    const { rerender, container } = renderRunning();

    rerender(
      <NarrativeIndicator
        stepCount={3}
        subagentCount={0}
        activeToolCalls={[]}
        startTime={Date.now()}
        isAgentRunning={false}
      />,
    );
    expect(container.querySelector('[data-state="exiting"]')).not.toBeNull();

    rerender(
      <NarrativeIndicator
        stepCount={0}
        subagentCount={0}
        activeToolCalls={[]}
        startTime={Date.now()}
        isAgentRunning
      />,
    );
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector('[data-state="running"]')).not.toBeNull();
  });

  it("keeps file facts out of the narrative status line", () => {
    const misplacedFileEffects = {
      fileEffects: { revision: 1, fileCount: 1, additions: 4, deletions: 2, effects: [] },
    };
    render(
      <NarrativeIndicator
        stepCount={2}
        subagentCount={0}
        activeToolCalls={[]}
        isAgentRunning
        {...misplacedFileEffects}
      />,
    );
    expect(screen.queryByText("1 file changed")).not.toBeInTheDocument();
    expect(screen.queryByText("+4")).not.toBeInTheDocument();
    expect(screen.queryByText("−2")).not.toBeInTheDocument();
  });
});
