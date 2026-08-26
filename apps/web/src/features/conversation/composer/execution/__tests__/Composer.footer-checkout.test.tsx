import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

describe("Composer footer visibility", () => {
  it("reserves the footer strip for branch mode", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const composerSource = readFileSync(resolve(here, "../../Composer.tsx"), "utf8");
    const statusStripSource = readFileSync(resolve(here, "../../ComposerStatusStrip.tsx"), "utf8");

    expect(composerSource).toContain("const showComposerStatusBar = !!branchFromMessageId;");
    expect(statusStripSource).toContain("aria-hidden={!props.visible}");
    expect(statusStripSource).toContain("inert={props.visible ? undefined : true}");
    expect(composerSource).not.toContain('import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";');
    expect(composerSource).not.toContain("selectedBranch={resolveThreadCheckoutLabel(activeThread)}");
  });
});
