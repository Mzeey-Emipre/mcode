import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Badge } from "@/components/ui/badge";

describe("Badge", () => {
  it("renders default size with h-5 and px-2", () => {
    const { container } = render(<Badge>Status</Badge>);
    const badge = container.firstElementChild!;
    expect(badge.className).toContain("h-5");
    expect(badge.className).toContain("px-2");
  });

  it("renders sm size with h-4 and px-1.5", () => {
    const { container } = render(<Badge size="sm">Status</Badge>);
    const badge = container.firstElementChild!;
    expect(badge.className).toContain("h-4");
    expect(badge.className).toContain("px-1.5");
  });

  it("applies variant alongside size", () => {
    const { container } = render(<Badge variant="secondary" size="sm">Tag</Badge>);
    const badge = container.firstElementChild!;
    expect(badge.className).toContain("h-4");
    expect(badge.className).toContain("bg-secondary");
  });
});
