import { describe, expect, it, vi } from "vitest";
import { loadPreviewGuestUrl } from "../guest-navigation.js";

function guest(initialUrl = "https://example.test/current") {
  let currentUrl = initialUrl;
  return {
    getURL: vi.fn(() => currentUrl),
    loadURL: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    commit(url: string) {
      currentUrl = url;
    },
  };
}

describe("loadPreviewGuestUrl", () => {
  it("returns the final committed URL after a successful load", async () => {
    const webContents = guest();

    await expect(loadPreviewGuestUrl(
      webContents as never,
      "https://example.test/next",
    )).resolves.toEqual({
      status: "committed",
      url: "https://example.test/next",
    });
  });

  it("accepts ERR_ABORTED after Chromium commits a new URL", async () => {
    const webContents = guest();
    webContents.loadURL.mockImplementationOnce(async () => {
      webContents.commit("https://example.test/final");
      throw Object.assign(new Error("ERR_ABORTED (-3)"), {
        code: "ERR_ABORTED",
        errno: -3,
      });
    });

    await expect(loadPreviewGuestUrl(
      webContents as never,
      "https://example.test/redirect",
    )).resolves.toEqual({
      status: "committed",
      url: "https://example.test/final",
    });
  });

  it("rejects ERR_ABORTED when the previous page stays active", async () => {
    const webContents = guest();
    webContents.loadURL.mockRejectedValueOnce(Object.assign(new Error("ERR_ABORTED (-3)"), {
      code: "ERR_ABORTED",
      errno: -3,
    }));

    await expect(loadPreviewGuestUrl(
      webContents as never,
      "https://example.test/next",
    )).resolves.toEqual({
      status: "failed",
      url: "https://example.test/current",
      errorCode: "ERR_ABORTED",
      errorNumber: -3,
    });
  });

  it("rejects an aborted load that commits a Chromium error page", async () => {
    const webContents = guest();
    webContents.loadURL.mockImplementationOnce(async () => {
      webContents.commit("chrome-error://chromewebdata/");
      throw Object.assign(new Error("ERR_ABORTED (-3)"), {
        code: "ERR_ABORTED",
        errno: -3,
      });
    });

    await expect(loadPreviewGuestUrl(
      webContents as never,
      "https://example.test/next",
    )).resolves.toMatchObject({
      status: "failed",
      url: "chrome-error://chromewebdata/",
      errorCode: "ERR_ABORTED",
      errorNumber: -3,
    });
  });
});
