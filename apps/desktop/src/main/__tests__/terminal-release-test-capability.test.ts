import { describe, expect, it } from "vitest";

import {
  buildTerminalReleaseTestRendererArguments,
  hasTerminalReleaseTestArgument,
  isTerminalReleaseTestEnabled,
  TERMINAL_RELEASE_TEST_ARGUMENT,
} from "../../features/terminal/release-test-capability.js";

describe("terminal release-test capability", () => {
  it("enables only for a packaged process with the release marker", () => {
    expect(isTerminalReleaseTestEnabled(true, "1")).toBe(true);
    expect(isTerminalReleaseTestEnabled(true, undefined)).toBe(false);
    expect(isTerminalReleaseTestEnabled(false, "1")).toBe(false);
  });

  it("builds the exact renderer argument only when enabled", () => {
    expect(buildTerminalReleaseTestRendererArguments(true)).toEqual([
      TERMINAL_RELEASE_TEST_ARGUMENT,
    ]);
    expect(buildTerminalReleaseTestRendererArguments(false)).toEqual([]);
  });

  it("recognizes the exact renderer argument", () => {
    expect(hasTerminalReleaseTestArgument([TERMINAL_RELEASE_TEST_ARGUMENT])).toBe(
      true,
    );
  });

  it("rejects near-matching renderer arguments", () => {
    expect(
      hasTerminalReleaseTestArgument([
        `${TERMINAL_RELEASE_TEST_ARGUMENT}=1`,
        `${TERMINAL_RELEASE_TEST_ARGUMENT}-extra`,
      ]),
    ).toBe(false);
  });
});
