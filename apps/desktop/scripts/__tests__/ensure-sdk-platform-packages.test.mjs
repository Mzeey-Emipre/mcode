import { describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
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
} from "../desktop-packaging/target-package/target-package.mjs";

const repoRoot = NodePath.resolve(import.meta.dirname, "../../../..");
const serverRoot = NodePath.join(repoRoot, "apps/server");

describe("SDK install layout resolution", () => {
  it("maps flat node_modules entries to their nearest install root", () => {
    const entry = NodePath.join(
      repoRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
      "sdk.mjs",
    );
    const installRoot = NodePath.join(repoRoot, "node_modules");

    expect(resolveInstallRoot(entry)).toBe(installRoot);
    expect(
      resolveInstallPackageDestination(
        entry,
        "@anthropic-ai/claude-agent-sdk-darwin-x64",
      ),
    ).toBe(
      NodePath.join(installRoot, "@anthropic-ai", "claude-agent-sdk-darwin-x64"),
    );
  });

  it("maps isolated entries to their package graph node_modules", () => {
    const entry = NodePath.join(
      repoRoot,
      "node_modules",
      ".bun",
      "@anthropic-ai+claude-agent-sdk@0.3.212",
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
      "sdk.mjs",
    );
    const installRoot = NodePath.join(
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
      NodePath.join(installRoot, "@anthropic-ai", "claude-agent-sdk-darwin-x64"),
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
    const testSource = NodeFS.readFileSync(import.meta.filename, "utf8");
    expect(testSource).not.toMatch(/@github\+copilot@\d+\.\d+\.\d+/);
    const plan = resolveCopilotTargetPackagePlan(serverRoot, "darwin", "x64");
    const sdkEntry = NodeModule.createRequire(
      NodePath.join(serverRoot, "package.json"),
    ).resolve("@github/copilot-sdk");
    const installed = JSON.parse(
      NodeFS.readFileSync(
        NodePath.resolve(
          NodePath.dirname(sdkEntry),
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
      NodePath.join(resolveInstallRoot(sdkEntry), "@github", "copilot-darwin-x64"),
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
    const expected = `sha512-${NodeCrypto.createHash("sha512").update("good").digest("base64")}`;

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
      destination: NodePath.join(
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
        destination: NodePath.join(repoRoot, "outside-store"),
        installRoot: NodePath.join(repoRoot, "node_modules/.bun"),
      }),
    ).rejects.toThrow("Destination escapes install root");
  });
});

describe("desktop packaging workflow wiring", () => {
  it("keeps target preparation in one reusable workflow", () => {
    const reusable = NodeFS.readFileSync(
      NodePath.join(repoRoot, ".github/workflows/desktop-package-target.yml"),
      "utf8",
    );
    expect(reusable).toContain(
      "apps/desktop/scripts/desktop-packaging/target-package/target-package.mjs",
    );
    expect(reusable).toContain(
      "apps/desktop/scripts/desktop-packaging/package-validation/terminal-release-evidence.mjs target",
    );
    for (const workflow of [
      ".github/workflows/build-release.yml",
      ".github/workflows/desktop-package-dry-run.yml",
    ]) {
      const source = NodeFS.readFileSync(NodePath.join(repoRoot, workflow), "utf8");
      expect(source).toContain(
        "./.github/workflows/desktop-package-target.yml",
      );
      expect(source).not.toContain("ensure-sdk-platform-packages.mjs");
      expect(source).not.toContain("ci-package.mjs");
    }
    const nightly = NodeFS.readFileSync(
      NodePath.join(repoRoot, ".github/workflows/nightly-desktop.yml"),
      "utf8",
    );
    expect(nightly).toContain("./.github/workflows/desktop-package-target.yml");
    expect(nightly).not.toContain("apps/desktop/scripts/ci-package.mjs");
    expect(nightly).not.toContain("apps/desktop/scripts/smoke-test.mjs");
  });

  it("keeps aggregate evidence on both Stable and Nightly", () => {
    const nightly = NodeFS.readFileSync(
      NodePath.join(repoRoot, ".github/workflows/nightly-desktop.yml"),
      "utf8",
    );
    const stable = NodeFS.readFileSync(
      NodePath.join(repoRoot, ".github/workflows/build-release.yml"),
      "utf8",
    );
    const releasePlease = NodeFS.readFileSync(
      NodePath.join(repoRoot, "release-please-config.json"),
      "utf8",
    );
    expect(nightly).toContain("terminal-release-evidence.mjs aggregate");
    expect(nightly).toContain("gh release upload");
    expect(nightly).toContain("gh release edit");
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
    const nightly = NodeFS.readFileSync(
      NodePath.join(repoRoot, ".github/workflows/nightly-desktop.yml"),
      "utf8",
    );
    const stable = NodeFS.readFileSync(
      NodePath.join(repoRoot, ".github/workflows/build-release.yml"),
      "utf8",
    );
    const afterPack = NodeFS.readFileSync(
      NodePath.join(
        repoRoot,
        "apps/desktop/scripts/desktop-packaging/target-package/after-pack.mjs",
      ),
      "utf8",
    );

    expect(nightly).toContain("signing-required: false");
    const terminalSkipFlag = "MCODE" + "_SKIP_TERMINAL_ATTESTATION";
    expect(nightly).not.toContain(terminalSkipFlag);
    expect(afterPack).not.toContain(terminalSkipFlag);
    expect(stable).toContain("signing-required: true");
  });

  it("avoids empty Bash arrays when packaging unsigned macOS targets", () => {
    const reusable = NodeFS.readFileSync(
      NodePath.join(repoRoot, ".github/workflows/desktop-package-target.yml"),
      "utf8",
    );

    expect(reusable).not.toContain("notarize_args=()");
    expect(reusable).not.toContain('"${notarize_args[@]}"');
  });
});
