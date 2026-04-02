import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SegControl } from "@/components/settings/SegControl";

const opts = [
  { value: "a", label: "Option A" },
  { value: "b", label: "Option B" },
  { value: "c", label: "Option C", disabled: true },
];

describe("SegControl", () => {
  it("renders all options", () => {
    render(<SegControl options={opts} value="a" onChange={() => {}} />);
    expect(screen.getByText("Option A")).toBeTruthy();
    expect(screen.getByText("Option B")).toBeTruthy();
    expect(screen.getByText("Option C")).toBeTruthy();
  });

  it("calls onChange with the clicked value", () => {
    const fn = vi.fn();
    render(<SegControl options={opts} value="a" onChange={fn} />);
    fireEvent.click(screen.getByText("Option B"));
    expect(fn).toHaveBeenCalledWith("b");
  });

  it("does not call onChange for disabled options", () => {
    const fn = vi.fn();
    render(<SegControl options={opts} value="a" onChange={fn} />);
    fireEvent.click(screen.getByText("Option C"));
    expect(fn).not.toHaveBeenCalled();
  });

  it("marks the active option visually", () => {
    render(<SegControl options={opts} value="b" onChange={() => {}} />);
    const activeBtn = screen.getByText("Option B").closest("button");
    expect(activeBtn?.className).toContain("bg-background");
  });
});
