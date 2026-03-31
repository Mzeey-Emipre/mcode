import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Input } from "@/components/ui/input";

describe("Input", () => {
  it("renders default size with h-8 and text-sm", () => {
    const { container } = render(<Input placeholder="test" />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("h-8");
    expect(input.className).toContain("text-sm");
  });

  it("renders sm size with h-7 and text-xs", () => {
    const { container } = render(<Input size="sm" placeholder="test" />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("h-7");
    expect(input.className).toContain("text-xs");
  });

  it("renders xs size with h-6 and text-xs", () => {
    const { container } = render(<Input size="xs" placeholder="test" />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("h-6");
    expect(input.className).toContain("text-xs");
  });

  it("applies custom className alongside size", () => {
    const { container } = render(<Input size="sm" className="w-40" placeholder="test" />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("h-7");
    expect(input.className).toContain("w-40");
  });
});
