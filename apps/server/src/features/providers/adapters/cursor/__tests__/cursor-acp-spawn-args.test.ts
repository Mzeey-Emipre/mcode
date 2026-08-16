import { describe, expect, it } from "vitest";
import { buildCursorAcpArgs } from "../cursor-acp-spawn-args.js";

describe("buildCursorAcpArgs", () => {
  it("uses acp subcommand and full-access flags on full mode", () => {
    expect(buildCursorAcpArgs({ permissionMode: "full", platform: "linux" })).toEqual([
      "acp",
      "--force",
      "--sandbox",
      "disabled",
    ]);
  });

  it("enables sandbox on macOS for default mode", () => {
    expect(buildCursorAcpArgs({ permissionMode: "default", platform: "darwin" })).toEqual([
      "acp",
      "--trust",
      "--sandbox",
      "enabled",
    ]);
  });

  it("disables sandbox on Windows for default mode", () => {
    expect(buildCursorAcpArgs({ permissionMode: "default", platform: "win32" })).toEqual([
      "acp",
      "--trust",
      "--sandbox",
      "disabled",
    ]);
  });
});
