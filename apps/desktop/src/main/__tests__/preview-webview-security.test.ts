import { describe, expect, it } from "vitest";
import {
  hardenPreviewWebviewAttachment,
  resolvePreviewGuestPreloadPath,
} from "../preview/preview-webview-security.js";

describe("preview webview security", () => {
  it("replaces hostile attachment settings with the fixed sandboxed guest preload", () => {
    const preferences = {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      devTools: false,
      preload: "C:/attacker/preload.js",
      preloadURL: "file:///attacker/preload.js",
    };
    const params = { partition: "persist:attacker", preload: "C:/attacker/preload.js" };
    const fixed = resolvePreviewGuestPreloadPath("C:/mcode/dist/main");
    hardenPreviewWebviewAttachment(preferences, params, fixed);
    expect(preferences).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: true,
      preload: fixed,
    });
    expect(params).toEqual({ partition: "persist:mcode-preview", preload: fixed });
    expect(fixed.replaceAll("\\", "/")).toBe("C:/mcode/dist/preload/preview-guest-preload.cjs");
  });

});
