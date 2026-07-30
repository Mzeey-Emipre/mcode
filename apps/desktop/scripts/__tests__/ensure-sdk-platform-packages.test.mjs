import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  copilotSdkPlatformPackageName,
  downloadAndExtractPackage,
  packageMetadataUsable,
  verifyPackageIntegrity,
  resolveCopilotTargetPackagePlan,
} from "../../../../apps/desktop/scripts/ensure-sdk-platform-packages.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const serverRoot = path.join(repoRoot, "apps/server");

describe("Copilot SDK target package preparation", () => {
  it("derives the target package version from installed Copilot metadata", () => {
    const testSource = readFileSync(import.meta.filename, "utf8");
    expect(testSource).not.toMatch(/@github\+copilot@\d+\.\d+\.\d+/);
    const plan = resolveCopilotTargetPackagePlan(serverRoot, "darwin", "x64");
    const sdkEntry = createRequire(path.join(serverRoot, "package.json")).resolve(
      "@github/copilot-sdk",
    );
    const installed = JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(sdkEntry),
          "..",
          "..",
          "..",
          "copilot",
          "package.json",
        ),
        "utf8",
      ),
    );

    expect(plan.platformPkg).toBe(
      copilotSdkPlatformPackageName("darwin", "x64"),
    );
    expect(plan.version).toBe(installed.version);
    expect(plan.destination).toContain(
      path.join("node_modules", "@github", "copilot-darwin-x64"),
    );
  });
});

describe("target package download safety", () => {
  it("rejects stale target metadata even when package resolution succeeds", () => {
    const plan = {
      platformPkg: "@github/copilot-darwin-x64",
      version: "1.0.25",
      platform: "darwin",
      arch: "x64",
      executable: "copilot",
    };
    const metadata = {
      name: plan.platformPkg,
      version: "1.0.24",
      os: ["darwin"],
      cpu: ["x64"],
      bin: { "copilot-darwin-x64": "copilot" },
    };

    expect(packageMetadataUsable(metadata, plan)).toBe(false);
  });

  it("rejects tarball bytes whose SHA-512 differs from bun.lock", () => {
    const expected = `sha512-${createHash("sha512").update("good").digest("base64")}`;

    expect(() => verifyPackageIntegrity(Buffer.from("bad"), expected)).toThrow(
      "integrity mismatch",
    );
    expect(() =>
      verifyPackageIntegrity(Buffer.from("good"), expected),
    ).not.toThrow();
  });

  it("rejects dot-segment package names and versions before fetching", async () => {
    const base = {
      version: "1.0.0",
      destination: path.join(
        repoRoot,
        "node_modules/.bun/node_modules/@github/test",
      ),
    };

    await expect(
      downloadAndExtractPackage({ ...base, packageName: "@github/../escape" }),
    ).rejects.toThrow("Unsupported package name");
    await expect(
      downloadAndExtractPackage({
        ...base,
        packageName: "@github/test",
        version: "1.0.0/..",
      }),
    ).rejects.toThrow("Unsupported package version");
  });

  it("rejects destinations outside the resolved Bun store", async () => {
    await expect(
      downloadAndExtractPackage({
        packageName: "@github/test",
        version: "1.0.0",
        destination: path.join(repoRoot, "outside-store"),
        bunStoreRoot: path.join(repoRoot, "node_modules/.bun"),
      }),
    ).rejects.toThrow("Destination escapes Bun store");
  });
});

describe("desktop packaging workflow wiring", () => {
  it("uses the shared SDK preparation entrypoint", () => {
    for (const workflow of [
      ".github/workflows/nightly-desktop.yml",
      ".github/workflows/build-release.yml",
      ".github/workflows/desktop-package-dry-run.yml",
    ]) {
      const source = readFileSync(path.join(repoRoot, workflow), "utf8");
      expect(source).toContain(
        "apps/desktop/scripts/ensure-sdk-platform-packages.mjs",
      );
      expect(source).not.toContain("ensure-claude-sdk-platform-package.mjs");
    }
  });
});
