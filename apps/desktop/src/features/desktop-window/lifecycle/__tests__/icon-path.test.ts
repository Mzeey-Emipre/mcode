import { describe, expect, it, vi } from "vitest";
import { join } from "path";

const iconPathTest = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => "C:/mcode"),
  },
}));

vi.mock("electron", () => ({ app: iconPathTest.app }));

import { getWindowIconPath } from "../icon-path.js";

describe("Desktop Window icon paths", () => {
  it.each([
    ["win32", "icon.ico"],
    ["darwin", "icon.icns"],
    ["linux", "icon.png"],
  ] as const)("resolves the development %s icon", (platform, iconFile) => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      iconPathTest.app.isPackaged = false;
      expect(getWindowIconPath()).toBe(join("C:/mcode", "build", iconFile));
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it("resolves packaged resources", () => {
    const originalPlatform = process.platform;
    const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    Object.defineProperty(process, "resourcesPath", {
      value: "C:/mcode/resources",
      configurable: true,
    });
    try {
      iconPathTest.app.isPackaged = true;
      expect(getWindowIconPath()).toBe(join("C:/mcode/resources", "icon.icns"));
    } finally {
      iconPathTest.app.isPackaged = false;
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
      if (originalResourcesPath) {
        Object.defineProperty(process, "resourcesPath", originalResourcesPath);
      } else {
        delete (process as { resourcesPath?: string }).resourcesPath;
      }
    }
  });
});
