import { describe, expect, it } from "vitest";
import { shouldPrintVersion } from "../cli-args";

describe("shouldPrintVersion", () => {
  it("detects the long version flag used by Linux artifact smoke tests", () => {
    expect(shouldPrintVersion(["/opt/Mcode/mcode-desktop", "--no-sandbox", "--version"])).toBe(true);
  });

  it("detects the short version flag", () => {
    expect(shouldPrintVersion(["mcode-desktop", "-v"])).toBe(true);
  });

  it("ignores normal app launches", () => {
    expect(shouldPrintVersion(["mcode-desktop", "--disable-gpu"])).toBe(false);
  });
});
