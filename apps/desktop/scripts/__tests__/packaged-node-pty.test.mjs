import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ensurePackagedConptyRuntime } from "../desktop-packaging/target-package/packaged-node-pty.mjs";

describe("ensurePackagedConptyRuntime", () => {
  /** @type {string} */
  let nodePtyRoot;

  beforeEach(() => {
    nodePtyRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-node-pty-"));
    const sourceDir = NodePath.join(
      nodePtyRoot,
      "third_party",
      "conpty",
      "1.2.3",
      "win10-x64",
    );
    NodeFS.mkdirSync(sourceDir, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(nodePtyRoot, "build", "Release"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(sourceDir, "conpty.dll"), "dll-runtime");
    NodeFS.writeFileSync(NodePath.join(sourceDir, "OpenConsole.exe"), "console-runtime");
    NodeFS.writeFileSync(NodePath.join(nodePtyRoot, "build", "Release", "conpty.node"), "binding");
  });

  afterEach(() => {
    NodeFS.rmSync(nodePtyRoot, { recursive: true, force: true });
  });

  it("copies the ConPTY runtime beside the rebuilt Windows binding", () => {
    const result = ensurePackagedConptyRuntime({ nodePtyRoot, arch: "x64" });

    expect(NodeFS.readFileSync(result.dllPath, "utf8")).toBe("dll-runtime");
    expect(NodeFS.readFileSync(result.openConsolePath, "utf8")).toBe("console-runtime");
    expect(result.dllPath).toBe(
      NodePath.join(nodePtyRoot, "build", "Release", "conpty", "conpty.dll"),
    );
  });

  it("accepts a complete runtime beside a target prebuilt binding", () => {
    NodeFS.rmSync(NodePath.join(nodePtyRoot, "build"), { recursive: true, force: true });
    NodeFS.rmSync(NodePath.join(nodePtyRoot, "third_party"), { recursive: true, force: true });
    const prebuildDir = NodePath.join(nodePtyRoot, "prebuilds", "win32-x64");
    NodeFS.mkdirSync(NodePath.join(prebuildDir, "conpty"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(prebuildDir, "conpty.node"), "binding");
    NodeFS.writeFileSync(NodePath.join(prebuildDir, "conpty", "conpty.dll"), "prebuilt-dll");
    NodeFS.writeFileSync(NodePath.join(prebuildDir, "conpty", "OpenConsole.exe"), "prebuilt-console");

    const result = ensurePackagedConptyRuntime({ nodePtyRoot, arch: "x64" });

    expect(NodeFS.readFileSync(result.dllPath, "utf8")).toBe("prebuilt-dll");
    expect(NodeFS.readFileSync(result.openConsolePath, "utf8")).toBe("prebuilt-console");
  });

  it("fails packaging when the rebuilt binding has no matching runtime", () => {
    NodeFS.rmSync(NodePath.join(nodePtyRoot, "third_party"), { recursive: true, force: true });

    expect(() =>
      ensurePackagedConptyRuntime({ nodePtyRoot, arch: "x64" }),
    ).toThrow("Could not find the x64 ConPTY runtime");
  });
});
