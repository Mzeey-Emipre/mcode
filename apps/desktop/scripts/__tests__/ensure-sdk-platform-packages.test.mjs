import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  copilotSdkPlatformPackageName,
  downloadTargetPackage,
  downloadAndExtractPackage,
  packageMetadataUsable,
  resolveClaudeTargetPackagePlan,
  resolveInstallPackageDestination,
  resolveInstallRoot,
  verifyPackageIntegrity,
  resolveCopilotTargetPackagePlan,
} from "../../../../apps/desktop/scripts/ensure-sdk-platform-packages.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const serverRoot = path.join(repoRoot, "apps/server");

describe("SDK install layout resolution", () => {
  it("maps flat node_modules entries to their nearest install root", () => {
    const entry = path.join(
      repoRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
      "sdk.mjs",
    );
    const installRoot = path.join(repoRoot, "node_modules");

    expect(resolveInstallRoot(entry)).toBe(installRoot);
    expect(
      resolveInstallPackageDestination(
        entry,
        "@anthropic-ai/claude-agent-sdk-darwin-x64",
      ),
    ).toBe(
      path.join(installRoot, "@anthropic-ai", "claude-agent-sdk-darwin-x64"),
    );
  });

  it("maps isolated entries to their package graph node_modules", () => {
    const entry = path.join(
      repoRoot,
      "node_modules",
      ".bun",
      "@anthropic-ai+claude-agent-sdk@0.3.212",
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
      "sdk.mjs",
    );
    const installRoot = path.join(
      repoRoot,
      "node_modules",
      ".bun",
      "@anthropic-ai+claude-agent-sdk@0.3.212",
      "node_modules",
    );

    expect(resolveInstallRoot(entry)).toBe(installRoot);
    expect(
      resolveInstallPackageDestination(
        entry,
        "@anthropic-ai/claude-agent-sdk-darwin-x64",
      ),
    ).toBe(
      path.join(installRoot, "@anthropic-ai", "claude-agent-sdk-darwin-x64"),
    );
  });
});

describe("Copilot SDK target package preparation", () => {
  it("passes canonical package names and integrity to missing-package downloader", async () => {
    const requests = [];
    const downloader = async (request) => requests.push(request);
    const claudePlan = resolveClaudeTargetPackagePlan(
      serverRoot,
      "darwin",
      "x64",
    );
    const copilotPlan = resolveCopilotTargetPackagePlan(
      serverRoot,
      "darwin",
      "x64",
    );

    await downloadTargetPackage(claudePlan, downloader);
    await downloadTargetPackage(copilotPlan, downloader);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      packageName: "@anthropic-ai/claude-agent-sdk-darwin-x64",
      version: claudePlan.version,
      integrity: claudePlan.integrity,
    });
    expect(requests[1]).toMatchObject({
      packageName: "@github/copilot-darwin-x64",
      version: copilotPlan.version,
      integrity: copilotPlan.integrity,
    });
  });

  it("derives the target package version from installed Copilot metadata", () => {
    const testSource = readFileSync(import.meta.filename, "utf8");
    expect(testSource).not.toMatch(/@github\+copilot@\d+\.\d+\.\d+/);
    const plan = resolveCopilotTargetPackagePlan(serverRoot, "darwin", "x64");
    const sdkEntry = createRequire(
      path.join(serverRoot, "package.json"),
    ).resolve("@github/copilot-sdk");
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

    expect(plan.packageName).toBe(
      copilotSdkPlatformPackageName("darwin", "x64"),
    );
    expect(plan.version).toBe(installed.version);
    expect(plan.destination).toBe(
      path.join(resolveInstallRoot(sdkEntry), "@github", "copilot-darwin-x64"),
    );
  });
});

describe("target package download safety", () => {
  it("rejects stale target metadata even when package resolution succeeds", () => {
    const plan = {
      packageName: "@github/copilot-darwin-x64",
      version: "1.0.25",
      platform: "darwin",
      arch: "x64",
      executable: "copilot",
    };
    const metadata = {
      name: plan.packageName,
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

  it("rejects destinations outside the resolved install root", async () => {
    await expect(
      downloadAndExtractPackage({
        packageName: "@github/test",
        version: "1.0.0",
        destination: path.join(repoRoot, "outside-store"),
        installRoot: path.join(repoRoot, "node_modules/.bun"),
      }),
    ).rejects.toThrow("Destination escapes install root");
  });
});

describe("desktop packaging workflow wiring", () => {
  it("keeps target preparation in one reusable workflow", () => {
    const reusable = readFileSync(
      path.join(repoRoot, ".github/workflows/desktop-package-target.yml"),
      "utf8",
    );
    expect(reusable).toContain(
      "apps/desktop/scripts/ensure-sdk-platform-packages.mjs",
    );
    expect(reusable).toContain(
      "apps/desktop/scripts/terminal-release-evidence.mjs target",
    );
    for (const workflow of [
      ".github/workflows/nightly-desktop.yml",
      ".github/workflows/build-release.yml",
      ".github/workflows/desktop-package-dry-run.yml",
    ]) {
      const source = readFileSync(path.join(repoRoot, workflow), "utf8");
      expect(source).toContain(
        "./.github/workflows/desktop-package-target.yml",
      );
      expect(source).not.toContain("ensure-sdk-platform-packages.mjs");
      expect(source).not.toContain("ci-package.mjs");
    }
  });

  it("publishes Nightly and Stable only after aggregate evidence passes", () => {
    const nightly = readFileSync(
      path.join(repoRoot, ".github/workflows/nightly-desktop.yml"),
      "utf8",
    );
    const stable = readFileSync(
      path.join(repoRoot, ".github/workflows/build-release.yml"),
      "utf8",
    );
    const releasePlease = readFileSync(
      path.join(repoRoot, "release-please-config.json"),
      "utf8",
    );
    expect(nightly.indexOf("terminal-release-evidence.mjs aggregate")).toBeLessThan(
      nightly.indexOf("gh release edit"),
    );
    expect(stable.indexOf("terminal-release-evidence.mjs aggregate")).toBeLessThan(
      stable.indexOf("gh release edit"),
    );
    expect(JSON.parse(releasePlease)).toMatchObject({
      draft: true,
      "force-tag-creation": true,
    });
    expect(stable).not.toContain("types: [published]");
  });

  it("keeps Nightly unsigned while Stable requires production signing", () => {
    const nightly = readFileSync(
      path.join(repoRoot, ".github/workflows/nightly-desktop.yml"),
      "utf8",
    );
    const stable = readFileSync(
      path.join(repoRoot, ".github/workflows/build-release.yml"),
      "utf8",
    );

    expect(nightly).toContain("signing-required: false");
    expect(stable).toContain("signing-required: true");
  });

  it("avoids empty Bash arrays when packaging unsigned macOS targets", () => {
    const reusable = readFileSync(
      path.join(repoRoot, ".github/workflows/desktop-package-target.yml"),
      "utf8",
    );

    expect(reusable).not.toContain("notarize_args=()");
    expect(reusable).not.toContain('"${notarize_args[@]}"');
  });
});
