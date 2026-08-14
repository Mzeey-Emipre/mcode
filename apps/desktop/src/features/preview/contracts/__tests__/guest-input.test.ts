import { describe, expect, it } from "vitest";
import {
  PREVIEW_GUEST_AGENT_INPUT_CHANNEL,
  PREVIEW_GUEST_CLIPBOARD_TRUST_CHANNEL,
  PREVIEW_GUEST_HUMAN_INPUT_CHANNEL,
  PreviewGuestInputSuppressor,
  toPreviewGuestHumanInputMessage,
} from "../guest-input.js";

describe("preview guest input contract", () => {
  it("emits only the narrow host contract for trusted human input", () => {
    expect(PREVIEW_GUEST_HUMAN_INPUT_CHANNEL).toBe("mcode:browser-human-input");
    expect(PREVIEW_GUEST_CLIPBOARD_TRUST_CHANNEL).toBe("mcode:browser-clipboard-trust");
    expect(toPreviewGuestHumanInputMessage("keydown", true)).toEqual({ kind: "keyboard" });
    expect(toPreviewGuestHumanInputMessage("pointerdown", true)).toEqual({ kind: "pointer" });
    expect(toPreviewGuestHumanInputMessage("touchstart", true)).toEqual({ kind: "touch" });
    expect(toPreviewGuestHumanInputMessage("wheel", true)).toEqual({ kind: "wheel" });
    expect(toPreviewGuestHumanInputMessage("focusin", true)).toBeNull();
    expect(toPreviewGuestHumanInputMessage("focusin", false)).toBeNull();
    expect(toPreviewGuestHumanInputMessage("click", true)).toBeNull();
    expect(toPreviewGuestHumanInputMessage("keydown", false)).toBeNull();
  });

  it("consumes only bounded matching agent input allowances", () => {
    expect(PREVIEW_GUEST_AGENT_INPUT_CHANNEL).toBe("mcode:browser-agent-input");
    const suppressor = new PreviewGuestInputSuppressor();
    expect(suppressor.allow({ action: "allow", token: "pointer-1", generation: 1, kind: "pointer", count: 2, expiresAt: 1_500 }, 1_000)).toBe(true);
    expect(suppressor.consume("pointer", 1_100)).toBe(true);
    expect(suppressor.consume("keyboard", 1_100)).toBe(false);
    expect(suppressor.consume("pointer", 1_200)).toBe(true);
    expect(suppressor.consume("pointer", 1_300)).toBe(false);
    expect(suppressor.allow({ action: "allow", token: "wheel-1", generation: 2, kind: "wheel", count: 1, expiresAt: 2_000 }, 1_000)).toBe(true);
    expect(suppressor.consume("wheel", 2_001)).toBe(false);
    expect(suppressor.allow({ action: "allow", token: "invalid", generation: 3, kind: "pointer", count: 17, expiresAt: 1_500 }, 1_000)).toBe(false);
  });

  it("revokes only a failed CDP allowance while retaining a successful delayed event", () => {
    const suppressor = new PreviewGuestInputSuppressor();
    expect(suppressor.allow({ action: "allow", token: "failed", generation: 1, kind: "pointer", count: 1, expiresAt: 6_000 }, 1_000)).toBe(true);
    expect(suppressor.allow({ action: "allow", token: "successful", generation: 2, kind: "pointer", count: 1, expiresAt: 6_000 }, 1_000)).toBe(true);
    expect(suppressor.revoke({ action: "revoke", token: "failed", generation: 2 }, 1_001)).toBe(false);
    expect(suppressor.revoke({ action: "revoke", token: "failed", generation: 1 }, 1_001)).toBe(true);
    expect(suppressor.consume("pointer", 1_100)).toBe(true);
    expect(suppressor.consume("pointer", 1_101)).toBe(false);
  });

  it("bounds retained allowances and expires them deterministically", () => {
    const suppressor = new PreviewGuestInputSuppressor();
    for (let index = 0; index < 33; index += 1) {
      expect(suppressor.allow({
        action: "allow",
        token: `token-${index}`,
        generation: index + 1,
        kind: "pointer",
        count: 1,
        expiresAt: 6_000,
      }, 1_000)).toBe(true);
    }
    expect(suppressor.revoke({ action: "revoke", token: "token-0", generation: 1 }, 1_001)).toBe(false);
    expect(suppressor.revoke({ action: "revoke", token: "token-1", generation: 2 }, 1_001)).toBe(true);
    expect(suppressor.expire(6_001)).toBe(31);
    expect(suppressor.consume("pointer", 6_001)).toBe(false);
  });
});
