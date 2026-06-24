import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

describe("Composer footer checkout label", () => {
  it("uses the shared checkout label helper for the locked existing-thread branch control", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "Composer.tsx"), "utf8");

    expect(source).toContain('import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";');
    expect(source).toContain("selectedBranch={resolveThreadCheckoutLabel(activeThread)}");
  });
});
