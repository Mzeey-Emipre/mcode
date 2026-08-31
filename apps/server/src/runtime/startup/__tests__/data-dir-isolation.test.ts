import { describe, it, expect } from "vitest";
import { getMcodeDir } from "@mcode/shared";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

describe("Test process data-dir isolation (#290)", () => {
  it("MCODE_DATA_DIR must be set during tests so the dev server log is not shared", () => {
    expect(process.env.MCODE_DATA_DIR).toBeTruthy();
  });

  it("getMcodeDir() resolves to a test-scoped path, NOT ~/.mcode or ~/.mcode-dev", () => {
    const dir = getMcodeDir();
    const home = NodeOS.homedir();
    expect(dir).not.toBe(NodePath.join(home, ".mcode"));
    expect(dir).not.toBe(NodePath.join(home, ".mcode-dev"));
  });
});
