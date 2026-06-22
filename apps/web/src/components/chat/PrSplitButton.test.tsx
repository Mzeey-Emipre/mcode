import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PrSplitButton } from "./PrSplitButton";

const noop = () => {};
const openPr = { number: 42, url: "https://github.com/o/r/pull/42", state: "OPEN" as const };

describe("PrSplitButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders View PR with the PR number for an active PR", () => {
    render(<PrSplitButton pr={openPr} onCreatePr={noop} onOpenPr={noop} />);

    expect(screen.getByRole("button", { name: "View PR #42" })).toHaveAttribute(
      "title",
      "View PR #42",
    );
    expect(screen.getByRole("button", { name: /open pr menu/i })).toBeInTheDocument();
  });

  it("calls onOpenPr from the View PR action", () => {
    const onOpenPr = vi.fn();
    render(<PrSplitButton pr={openPr} onCreatePr={noop} onOpenPr={onOpenPr} />);

    fireEvent.click(screen.getByRole("button", { name: "View PR #42" }));
    expect(onOpenPr).toHaveBeenCalledWith(
      "https://github.com/o/r/pull/42",
      expect.objectContaining({ type: "click" }),
    );
  });

  it("offers Create new PR from the menu", () => {
    const onCreatePr = vi.fn();
    render(
      <PrSplitButton
        pr={openPr}
        onCreatePr={onCreatePr}
        onOpenPr={noop}
        newPrButtonTestId="workspace-menu-new-pr"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open pr menu/i }));
    fireEvent.click(screen.getByTestId("workspace-menu-new-pr"));
    expect(onCreatePr).toHaveBeenCalledTimes(1);
  });
});
