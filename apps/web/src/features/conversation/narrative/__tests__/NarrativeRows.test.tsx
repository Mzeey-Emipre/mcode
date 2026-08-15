import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NarrativeItem } from "../types";
import { NarrativeRows } from "../NarrativeRows";

function thought(index: number): NarrativeItem {
  return {
    type: "thought",
    segment: { text: `Narrative row ${index}`, startedAt: index },
    isActive: false,
  };
}

describe("NarrativeRows", () => {
  it("bounds dense rows and restores their chronological order on expansion", () => {
    const items = Array.from({ length: 30 }, (_, index) => thought(index));
    const { rerender } = render(<NarrativeRows items={items} allToolCalls={[]} />);

    expect(screen.getByText("Narrative row 0")).toBeTruthy();
    expect(screen.queryByText("Narrative row 15")).toBeNull();
    expect(screen.getByText("Narrative row 29")).toBeTruthy();
    expect(screen.getAllByText(/^Narrative row \d+$/)).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Browse all 30 activity rows" }));

    expect(screen.getByText("Narrative row 15")).toBeTruthy();
    expect(screen.queryByText("Narrative row 29")).toBeNull();
    expect(screen.getAllByText(/^Narrative row \d+$/)).toHaveLength(24);
    const renderedText = screen.getAllByText(/^Narrative row \d+$/)
      .map((row) => row.textContent);
    expect(renderedText).toEqual(items.slice(0, 24).map((_, index) => `Narrative row ${index}`));

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.queryByText("Narrative row 15")).toBeNull();
    expect(screen.getByText("Narrative row 29")).toBeTruthy();
    expect(screen.getAllByText(/^Narrative row \d+$/)).toHaveLength(6);

    fireEvent.click(screen.getByRole("button", { name: "Summary" }));

    expect(screen.queryByText("Narrative row 15")).toBeNull();
    expect(screen.getAllByText(/^Narrative row \d+$/)).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Browse all 30 activity rows" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    rerender(<NarrativeRows items={[thought(100)]} allToolCalls={[]} />);

    expect(screen.getByText("Narrative row 100")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Summary" })).toBeNull();
  });
});
