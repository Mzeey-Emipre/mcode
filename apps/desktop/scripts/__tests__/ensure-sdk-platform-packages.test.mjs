import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  copilotSdkPlatformPackageName,
  resolveCopilotTargetPackagePlan,
} from "../../../../apps/desktop/scripts/ensure-sdk-platform-packages.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const serverRoot = path.join(repoRoot, "apps/server");

describe("Copilot SDK target package preparation", () => {
  it("derives the target package version from installed Copilot metadata", () => {
    const plan = resolveCopilotTargetPackagePlan(serverRoot, "darwin", "x64");

    expect(plan.platformPkg).toBe(
      copilotSdkPlatformPackageName("darwin", "x64"),
    );
    expect(plan.version).toBe("1.0.25");
    expect(plan.destination).toContain(
      path.join("node_modules", "@github", "copilot-darwin-x64"),
    );
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
