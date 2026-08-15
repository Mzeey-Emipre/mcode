import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

describe("Composer footer visibility", () => {
  it("reserves the footer strip for branch mode", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "../Composer.tsx"), "utf8");

    expect(source).toContain("const showComposerStatusBar = !!branchFromMessageId;");
    expect(source).toContain("aria-hidden={!showComposerStatusBar}");
    expect(source).toContain("inert={showComposerStatusBar ? undefined : true}");
    expect(source).not.toContain('import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";');
    expect(source).not.toContain("selectedBranch={resolveThreadCheckoutLabel(activeThread)}");
  });
});
