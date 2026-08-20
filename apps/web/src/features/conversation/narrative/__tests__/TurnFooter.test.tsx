import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TurnFooter } from "../TurnFooter";

describe("TurnFooter", () => {
  it("promotes completed durations over an hour out of total minutes", () => {
    render(
      <TurnFooter
        counts={{ steps: 2, thoughts: 0, subagents: 0 }}
        durationMs={7_070_000}
      />,
    );

    expect(screen.getByText("1h 57m")).toBeInTheDocument();
    expect(screen.queryByText("117m 50s")).not.toBeInTheDocument();
  });

  it.each([
    ["completed", undefined],
    ["legacy", null],
  ] as const)("does not render an outcome label or actions for %s turns", (_name, outcome) => {
    render(
      <TurnFooter
        counts={{ steps: 2, thoughts: 0, subagents: 0 }}
        durationMs={1_000}
        outcome={outcome}
        outcomeExecutionId="execution-1"
        onContinue={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("turn-outcome")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("places the cancelled label before activity counts without actions", () => {
    render(
      <TurnFooter
        counts={{ steps: 2, thoughts: 0, subagents: 1 }}
        durationMs={1_000}
        outcome="cancelled"
        onContinue={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    const label = screen.getByText("You stopped");
    const counts = screen.getByText("2 steps · 1 sub-agent");
    expect(label.compareDocumentPosition(counts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("fires Continue and exact-identity Retry for an interrupted turn", () => {
    const onContinue = vi.fn();
    const onRetry = vi.fn();
    render(
      <TurnFooter
        counts={{ steps: 1, thoughts: 0, subagents: 0 }}
        durationMs={1_000}
        outcome="interrupted"
        outcomeExecutionId="execution-42"
        onContinue={onContinue}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("Turn interrupted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith("execution-42");
  });

  it("fires exact-identity Retry for an errored turn", () => {
    const onRetry = vi.fn();
    render(
      <TurnFooter
        counts={{ steps: 1, thoughts: 0, subagents: 0 }}
        durationMs={1_000}
        outcome="errored"
        outcomeExecutionId="execution-99"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("Turn failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("execution-99");
  });
});
