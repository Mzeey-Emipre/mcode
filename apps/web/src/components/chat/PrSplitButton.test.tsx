import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PrSplitButton } from "./PrSplitButton";

const noop = () => {};
const openPr = { number: 42, url: "https://github.com/o/r/pull/42", state: "OPEN" as const };

describe("PrSplitButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the PR label and row trigger for an active PR", () => {
    render(
      <PrSplitButton
        pr={openPr}
        label="PR #42"
        onCreatePr={noop}
        onOpenPr={noop}
        primaryButtonTestId="workspace-menu-open-pr"
      />,
    );

    expect(screen.getByTestId("workspace-menu-open-pr")).toHaveTextContent("PR #42");
  });

  it("uses machine typography for a generated PR number", () => {
    render(
      <PrSplitButton
        pr={openPr}
        label="PR #42"
        machineLabel
        onCreatePr={noop}
        onOpenPr={noop}
        primaryButtonTestId="workspace-menu-open-pr"
      />,
    );

    expect(screen.getByText("PR #42")).toHaveClass("font-mono", "tabular-nums");
  });

  it("calls onOpenPr from the popover action", () => {
    const onOpenPr = vi.fn();
    render(
      <PrSplitButton
        pr={openPr}
        label="PR #42"
        onCreatePr={noop}
        onOpenPr={onOpenPr}
        primaryButtonTestId="workspace-menu-open-pr"
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-menu-open-pr"));
    fireEvent.click(screen.getByTestId("workspace-menu-open-pr-action"));
    expect(onOpenPr).toHaveBeenCalledWith(
      "https://github.com/o/r/pull/42",
      expect.objectContaining({ type: "click" }),
    );
  });

  it("offers Create new PR from the popover", () => {
    const onCreatePr = vi.fn();
    render(
      <PrSplitButton
        pr={openPr}
        label="PR #42"
        onCreatePr={onCreatePr}
        onOpenPr={noop}
        primaryButtonTestId="workspace-menu-open-pr"
        newPrButtonTestId="workspace-menu-new-pr"
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-menu-open-pr"));
    fireEvent.click(screen.getByTestId("workspace-menu-new-pr"));
    expect(onCreatePr).toHaveBeenCalledTimes(1);
  });
});
