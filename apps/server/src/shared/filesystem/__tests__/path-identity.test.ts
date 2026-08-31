import { describe, expect, it } from "vitest";
import { stripWindowsPathNamespace } from "../path-identity.js";

describe("stripWindowsPathNamespace", () => {
  it("removes the Windows namespace only for an explicit Windows platform", () => {
    const path = "\\\\?\\C:\\Workspace\\Mcode";

    expect(stripWindowsPathNamespace(path, "win32")).toBe("C:\\Workspace\\Mcode");
    expect(stripWindowsPathNamespace(path, "linux")).toBe(path);
  });
});
