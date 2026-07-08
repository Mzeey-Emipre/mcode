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

  it("renders sm size as the small input alias", () => {
    const { container } = render(<Input size="sm" placeholder="test" />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("h-8");
    expect(input.className).toContain("text-sm");
  });

  it("renders xs size as the small input alias", () => {
    const { container } = render(<Input size="xs" placeholder="test" />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("h-8");
    expect(input.className).toContain("text-sm");
  });

  it("renders md and lg sizes on the documented control scale", () => {
    const { container } = render(
      <>
        <Input size="md" placeholder="medium" />
        <Input size="lg" placeholder="large" />
      </>
    );
    const [md, lg] = Array.from(container.querySelectorAll("input"));
    expect(md.className).toContain("h-12");
    expect(md.className).toContain("text-base");
    expect(lg.className).toContain("h-14");
    expect(lg.className).toContain("text-lg");
  });

  it("applies custom className alongside size", () => {
    const { container } = render(<Input size="sm" className="w-40" placeholder="test" />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("h-8");
    expect(input.className).toContain("w-40");
  });
});
