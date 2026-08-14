import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  isTerminalReleaseTestEnvironmentName,
  parseTerminalReleaseTestInput,
} from "./terminal-release-test-input.js";

const packaged = { resourcesPresent: true } as const;

describe("protected Terminal release-test input", () => {
  it("accepts one allowlisted optional fault only behind both gates", () => {
    expect(
      parseTerminalReleaseTestInput(
        {
          MCODE_TERMINAL_RELEASE_TEST: "1",
          MCODE_TERMINAL_BACKEND: "modern",
          MCODE_TERMINAL_RELEASE_FAULT: "containment-failure",
        },
        packaged,
      ),
    ).toEqual({ enabled: true, backend: "modern", fault: "containment-failure" });
    expect(
      parseTerminalReleaseTestInput(
        { MCODE_TERMINAL_RELEASE_TEST: "1", MCODE_TERMINAL_BACKEND: "modern" },
        packaged,
      ),
    ).toEqual({ enabled: true, backend: "modern" });
  });

  it("accepts the canonical packaged resources root passed to the server child", () => {
    const resourcesRoot = realpathSync(mkdtempSync(join(tmpdir(), "mcode-resources-")));
    try {
      mkdirSync(join(resourcesRoot, "app.asar.unpacked"));
      expect(
        parseTerminalReleaseTestInput({
          MCODE_TERMINAL_RELEASE_TEST: "1",
          MCODE_TERMINAL_BACKEND: "modern",
          MCODE_PACKAGED_RESOURCES_ROOT: resourcesRoot,
        }),
      ).toEqual({ enabled: true, backend: "modern" });

      const nonCanonicalRoot = `${resourcesRoot}${sep}.`;
      expect(() =>
        parseTerminalReleaseTestInput({
          MCODE_TERMINAL_RELEASE_TEST: "1",
          MCODE_TERMINAL_BACKEND: "modern",
          MCODE_PACKAGED_RESOURCES_ROOT: nonCanonicalRoot,
        }),
      ).toThrow(/packaged/i);
    } finally {
      rmSync(resourcesRoot, { recursive: true, force: true });
    }
  });

  it("leaves protected development selection alone and rejects malformed release input", () => {
    expect(
      parseTerminalReleaseTestInput({ MCODE_TERMINAL_BACKEND: "modern" }),
    ).toBeNull();
    expect(() =>
      parseTerminalReleaseTestInput({ MCODE_TERMINAL_RELEASE_TEST: "1" }),
    ).toThrow(/packaged/i);
    expect(() =>
      parseTerminalReleaseTestInput(
        {
          MCODE_TERMINAL_RELEASE_TEST: "1",
          MCODE_TERMINAL_BACKEND: "modern",
          MCODE_TERMINAL_RELEASE_FAULT: "not-allowlisted",
        },
        packaged,
      ),
    ).toThrow(/allowlisted/i);
    expect(() =>
      parseTerminalReleaseTestInput(
        {
          MCODE_TERMINAL_RELEASE_TEST: "1",
          MCODE_TERMINAL_BACKEND: "modern",
          MCODE_TERMINAL_RELEASE_FAULT: "containment-failure",
          MCODE_TERMINAL_RELEASE_FAULTS: "containment-failure",
        },
        packaged,
      ),
    ).toThrow(/repeated/i);
    expect(() =>
      parseTerminalReleaseTestInput(
        {
          MCODE_TERMINAL_RELEASE_TEST: "1",
          MCODE_TERMINAL_BACKEND: "modern",
          MCODE_TERMINAL_RELEASE_FAULT: "x".repeat(65),
        },
        packaged,
      ),
    ).toThrow(/allowlisted|oversized/i);
    expect(() =>
      parseTerminalReleaseTestInput(
        {
          MCODE_TERMINAL_RELEASE_TEST: "1",
          MCODE_TERMINAL_BACKEND: "modern",
          MCODE_TERMINAL_RELEASE_UNKNOWN: "1",
        },
        packaged,
      ),
    ).toThrow(/unknown/i);
  });

  it("keeps protected variables out of child shell snapshots", () => {
    expect(isTerminalReleaseTestEnvironmentName("MCODE_TERMINAL_RELEASE_TEST")).toBe(true);
    expect(isTerminalReleaseTestEnvironmentName("MCODE_TERMINAL_RELEASE_FAULT")).toBe(true);
    expect(isTerminalReleaseTestEnvironmentName("MCODE_TERMINAL_BACKEND")).toBe(false);
    expect(isTerminalReleaseTestEnvironmentName("PATH")).toBe(false);
  });
});
