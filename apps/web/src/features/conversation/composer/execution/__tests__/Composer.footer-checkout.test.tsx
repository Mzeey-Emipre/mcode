import { describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";

describe("Composer footer visibility", () => {
  it("reserves the footer strip for branch mode", () => {
    const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
    const composerSource = NodeFS.readFileSync(NodePath.resolve(here, "../../Composer.tsx"), "utf8");
    const statusStripSource = NodeFS.readFileSync(NodePath.resolve(here, "../../ComposerStatusStrip.tsx"), "utf8");

    expect(composerSource).toContain("const showComposerStatusBar = !!branchFromMessageId;");
    expect(statusStripSource).toContain("aria-hidden={!props.visible}");
    expect(statusStripSource).toContain("inert={props.visible ? undefined : true}");
    expect(composerSource).not.toContain('import { resolveThreadCheckoutLabel } from "@/lib/checkout-label";');
    expect(composerSource).not.toContain("selectedBranch={resolveThreadCheckoutLabel(activeThread)}");
  });
});
