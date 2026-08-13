import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePackagedConptyRuntime } from "../desktop-packaging/target-package/packaged-node-pty.mjs";

describe("ensurePackagedConptyRuntime", () => {
  /** @type {string} */
  let nodePtyRoot;

  beforeEach(() => {
    nodePtyRoot = mkdtempSync(path.join(tmpdir(), "mcode-node-pty-"));
    const sourceDir = path.join(
      nodePtyRoot,
      "third_party",
      "conpty",
      "1.2.3",
      "win10-x64",
    );
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(path.join(nodePtyRoot, "build", "Release"), { recursive: true });
    writeFileSync(path.join(sourceDir, "conpty.dll"), "dll-runtime");
    writeFileSync(path.join(sourceDir, "OpenConsole.exe"), "console-runtime");
    writeFileSync(path.join(nodePtyRoot, "build", "Release", "conpty.node"), "binding");
  });

  afterEach(() => {
    rmSync(nodePtyRoot, { recursive: true, force: true });
  });

  it("copies the ConPTY runtime beside the rebuilt Windows binding", () => {
    const result = ensurePackagedConptyRuntime({ nodePtyRoot, arch: "x64" });

    expect(readFileSync(result.dllPath, "utf8")).toBe("dll-runtime");
    expect(readFileSync(result.openConsolePath, "utf8")).toBe("console-runtime");
    expect(result.dllPath).toBe(
      path.join(nodePtyRoot, "build", "Release", "conpty", "conpty.dll"),
    );
  });

  it("accepts a complete runtime beside a target prebuilt binding", () => {
    rmSync(path.join(nodePtyRoot, "build"), { recursive: true, force: true });
    rmSync(path.join(nodePtyRoot, "third_party"), { recursive: true, force: true });
    const prebuildDir = path.join(nodePtyRoot, "prebuilds", "win32-x64");
    mkdirSync(path.join(prebuildDir, "conpty"), { recursive: true });
    writeFileSync(path.join(prebuildDir, "conpty.node"), "binding");
    writeFileSync(path.join(prebuildDir, "conpty", "conpty.dll"), "prebuilt-dll");
    writeFileSync(path.join(prebuildDir, "conpty", "OpenConsole.exe"), "prebuilt-console");

    const result = ensurePackagedConptyRuntime({ nodePtyRoot, arch: "x64" });

    expect(readFileSync(result.dllPath, "utf8")).toBe("prebuilt-dll");
    expect(readFileSync(result.openConsolePath, "utf8")).toBe("prebuilt-console");
  });

  it("fails packaging when the rebuilt binding has no matching runtime", () => {
    rmSync(path.join(nodePtyRoot, "third_party"), { recursive: true, force: true });

    expect(() =>
      ensurePackagedConptyRuntime({ nodePtyRoot, arch: "x64" }),
    ).toThrow("Could not find the x64 ConPTY runtime");
  });
});
