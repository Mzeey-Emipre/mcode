import { describe, expect, it } from "vitest";
import { sanitizePackageManifest } from "../sanitize-package-manifest.mjs";

describe("sanitizePackageManifest", () => {
  it("removes workspace protocol entries from every npm dependency field", () => {
    const manifest = {
      name: "fixture",
      version: "1.0.0",
      dependencies: {
        "@mcode/server": "workspace:*",
        "better-sqlite3": "^11.8.0",
      },
      devDependencies: {
        "@mcode/browser-conformance": "workspace:*",
        vitest: "^3.2.4",
      },
      optionalDependencies: {
        "@mcode/optional": "workspace:^",
        koffi: "2.14.1",
      },
      peerDependencies: {
        "@mcode/peer": "workspace:~",
        electron: ">=35",
      },
      scripts: { test: "vitest" },
      custom: { keep: true },
    };
    const original = structuredClone(manifest);

    expect(sanitizePackageManifest(manifest)).toEqual({
      name: "fixture",
      version: "1.0.0",
      dependencies: { "better-sqlite3": "^11.8.0" },
      devDependencies: { vitest: "^3.2.4" },
      optionalDependencies: { koffi: "2.14.1" },
      peerDependencies: { electron: ">=35" },
      scripts: { test: "vitest" },
      custom: { keep: true },
    });
    expect(manifest).toEqual(original);
  });
});
