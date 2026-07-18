import { describe, expect, it } from "vitest";
import {
  LEGACY_BROWSER_USE_PIPE_ENV,
  shouldStartLegacyBrowserUseBridge,
} from "../browser-use/rollout.js";

describe("legacy browser-use rollout", () => {
  it("keeps the raw pipe disabled unless the hidden rollback switch is exact", () => {
    expect(shouldStartLegacyBrowserUseBridge({})).toBe(false);
    expect(shouldStartLegacyBrowserUseBridge({ [LEGACY_BROWSER_USE_PIPE_ENV]: "true" })).toBe(false);
    expect(shouldStartLegacyBrowserUseBridge({ [LEGACY_BROWSER_USE_PIPE_ENV]: "0" })).toBe(false);
    expect(shouldStartLegacyBrowserUseBridge({ [LEGACY_BROWSER_USE_PIPE_ENV]: "1" })).toBe(true);
  });
});
