import { describe, expect, it } from "vitest";
import { buttonVariants } from "@/components/ui/button";

describe("buttonVariants", () => {
  it("maps legacy text sizes to the small control scale", () => {
    for (const size of ["xs", "sm", "default"] as const) {
      const className = buttonVariants({ size });
      expect(className).toContain("h-8");
      expect(className).toContain("text-sm");
    }
  });

  it("maps md and lg text sizes to documented control scales", () => {
    const medium = buttonVariants({ size: "md" });
    const large = buttonVariants({ size: "lg" });

    expect(medium).toContain("h-12");
    expect(medium).toContain("text-base");
    expect(medium).toContain("size-6");
    expect(large).toContain("h-14");
    expect(large).toContain("text-lg");
    expect(large).toContain("size-8");
  });

  it("maps icon-only sizes to documented outer boxes", () => {
    for (const size of ["icon-xs", "icon-sm", "icon"] as const) {
      expect(buttonVariants({ size })).toContain("size-8");
    }

    expect(buttonVariants({ size: "icon-md" })).toContain("size-12");
    expect(buttonVariants({ size: "icon-lg" })).toContain("size-14");
  });
});
