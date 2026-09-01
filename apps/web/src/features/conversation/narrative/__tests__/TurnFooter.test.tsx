import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
      />,
    );

    const label = screen.getByText("You stopped");
    const counts = screen.getByText("2 steps · 1 sub-agent");
    expect(label.compareDocumentPosition(counts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows an interrupted turn without Continue or Retry", () => {
    render(
      <TurnFooter
        counts={{ steps: 1, thoughts: 0, subagents: 0 }}
        durationMs={1_000}
        outcome="interrupted"
      />,
    );

    expect(screen.getByText("Turn interrupted")).toBeInTheDocument();
    expect(screen.getByText("1.0s")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue|retry/i })).toBeNull();
  });

  it("shows failed turns without a recovery action", () => {
    render(
      <TurnFooter
        counts={{ steps: 1, thoughts: 0, subagents: 0 }}
        durationMs={1_000}
        outcome="errored"
      />,
    );

    expect(screen.getByText("Turn failed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue|retry/i })).toBeNull();
  });
});
