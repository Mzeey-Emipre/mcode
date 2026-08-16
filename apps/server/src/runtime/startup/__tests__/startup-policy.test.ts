import { describe, expect, it } from "vitest";
import { resolveWebAutomationFlag } from "../startup-policy.js";

describe("web automation startup policy", () => {
  it.each(["production", "test", "staging", undefined])(
    "disables truthy flag outside development (%s)",
    (NODE_ENV) => {
      expect(resolveWebAutomationFlag({ NODE_ENV, MCODE_WEB_AUTOMATION: "1" })).toBe(false);
    },
  );

  it("enables explicit truthy development flag", () => {
    expect(resolveWebAutomationFlag({ NODE_ENV: "development", MCODE_WEB_AUTOMATION: "true" })).toBe(true);
  });

  it.each([undefined, "0", "false", "off"])(
    "disables absent or false development flag (%s)",
    (MCODE_WEB_AUTOMATION) => {
      expect(resolveWebAutomationFlag({ NODE_ENV: "development", MCODE_WEB_AUTOMATION })).toBe(false);
    },
  );

  it("rejects invalid development values with explicit error", () => {
    expect(() => resolveWebAutomationFlag({ NODE_ENV: "development", MCODE_WEB_AUTOMATION: "maybe" }))
      .toThrow("MCODE_WEB_AUTOMATION must be true or false when set");
  });
});
