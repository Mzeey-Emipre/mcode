import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

describe("Composer footer visibility", () => {
  it("hides the workspace and branch strip on normal active threads", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "Composer.tsx"), "utf8");

    expect(source).toContain("const showComposerStatusBar = isNewThread === true || !!branchFromMessageId;");
    expect(source).toContain("aria-hidden={!showComposerStatusBar}");
    expect(source).not.toContain('import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";');
    expect(source).not.toContain("selectedBranch={resolveThreadCheckoutLabel(activeThread)}");
  });
});
