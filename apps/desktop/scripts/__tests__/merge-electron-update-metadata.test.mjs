import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeElectronUpdateMetadata } from "../desktop-packaging/publishers/merge-electron-update-metadata.mjs";

describe("mergeElectronUpdateMetadata", () => {
  let fixtureRoot;

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("keeps both architecture files without changing shared release metadata", () => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "electron-update-metadata-"));
    const primaryPath = path.join(fixtureRoot, "arm64.yml");
    const secondaryPath = path.join(fixtureRoot, "x64.yml");
    const outputPath = path.join(fixtureRoot, "merged.yml");
    writeFileSync(
      primaryPath,
      "version: 0.13.0\nfiles:\n  - url: Mcode-arm64.zip\n    sha512: arm\npath: Mcode-arm64.zip\n",
    );
    writeFileSync(
      secondaryPath,
      "version: 0.13.0\nfiles:\n  - url: Mcode-x64.zip\n    sha512: x64\npath: Mcode-x64.zip\n",
    );

    expect(
      mergeElectronUpdateMetadata(primaryPath, secondaryPath, outputPath),
    ).toEqual({ added: 1 });
    expect(readFileSync(outputPath, "utf8")).toContain("url: Mcode-arm64.zip");
    expect(readFileSync(outputPath, "utf8")).toContain("url: Mcode-x64.zip");
    expect(readFileSync(outputPath, "utf8")).toContain("path: Mcode-arm64.zip");
  });
});
