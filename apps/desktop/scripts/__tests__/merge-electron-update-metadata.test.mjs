import { afterEach, describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { mergeElectronUpdateMetadata } from "../desktop-packaging/publishers/merge-electron-update-metadata.mjs";

describe("mergeElectronUpdateMetadata", () => {
  let fixtureRoot;

  afterEach(() => {
    if (fixtureRoot) NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("keeps both architecture files without changing shared release metadata", () => {
    fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "electron-update-metadata-"));
    const primaryPath = NodePath.join(fixtureRoot, "arm64.yml");
    const secondaryPath = NodePath.join(fixtureRoot, "x64.yml");
    const outputPath = NodePath.join(fixtureRoot, "merged.yml");
    NodeFS.writeFileSync(
      primaryPath,
      "version: 0.13.0\nfiles:\n  - url: Mcode-arm64.zip\n    sha512: arm\npath: Mcode-arm64.zip\n",
    );
    NodeFS.writeFileSync(
      secondaryPath,
      "version: 0.13.0\nfiles:\n  - url: Mcode-x64.zip\n    sha512: x64\npath: Mcode-x64.zip\n",
    );

    expect(
      mergeElectronUpdateMetadata(primaryPath, secondaryPath, outputPath),
    ).toEqual({ added: 1 });
    expect(NodeFS.readFileSync(outputPath, "utf8")).toContain("url: Mcode-arm64.zip");
    expect(NodeFS.readFileSync(outputPath, "utf8")).toContain("url: Mcode-x64.zip");
    expect(NodeFS.readFileSync(outputPath, "utf8")).toContain("path: Mcode-arm64.zip");
  });
});
