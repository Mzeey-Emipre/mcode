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
});
