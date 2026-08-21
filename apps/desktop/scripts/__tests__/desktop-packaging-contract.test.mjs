import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertDesktopWorkflowMatrices,
  SUPPORTED_DESKTOP_TARGETS,
  resolveDesktopTarget,
  resolveDesktopTargetPackagePlans,
} from "../desktop-packaging/target-inventory/target-inventory.mjs";
import {
  classifyElectronBuilderFailure,
  runElectronBuilderWithRetry,
} from "../desktop-packaging/target-package/ci-package.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

describe("desktop packaging target inventory", () => {
  it("covers every target used by the package matrix", () => {
    expect(SUPPORTED_DESKTOP_TARGETS.map(({ id }) => id)).toEqual([
      "windows-x64",
      "linux-x64",
      "macos-arm64",
      "macos-x64",
    ]);
    for (const target of SUPPORTED_DESKTOP_TARGETS) {
      expect(resolveDesktopTarget(target.platform, target.arch)).toMatchObject(
        target,
      );
      const plans = resolveDesktopTargetPackagePlans(
        path.join(repoRoot, "apps/server"),
        target.platform,
        target.arch,
      );
      expect(plans.claude).toMatchObject({
        platform: expect.any(String),
        arch: target.arch,
        packageName: expect.stringContaining(target.arch),
      });
      expect(plans.copilot).toMatchObject({
        platform: expect.any(String),
        arch: target.arch,
        packageName: expect.stringContaining(target.arch),
      });
    }
  });

  it("rejects unsupported platform and architecture pairs", () => {
    expect(() => resolveDesktopTarget("windows", "arm64")).toThrow(
      "Unsupported desktop package target",
    );
    expect(() => resolveDesktopTarget("macos", "ia32")).toThrow(
      "Unsupported desktop package target",
    );
    expect(() => resolveDesktopTarget("freebsd", "x64")).toThrow(
      "Unsupported desktop package target",
    );
  });
});

describe("electron-builder transient failure classification", () => {
  it("retries Electron release downloads that fail with EOF", () => {
    expect(
      classifyElectronBuilderFailure(
        "GET https://github.com/electron/electron/releases/download/v35.7.5/electron.zip failed: EOF",
      ),
    ).toMatchObject({ retryable: true });
  });

  it("retries Electron release downloads that fail with ECONNRESET", () => {
    expect(
      classifyElectronBuilderFailure(
        "https://github.com/electron/electron/releases/download/v35.7.5/electron.zip ECONNRESET",
      ),
    ).toMatchObject({ retryable: true });
  });

  it("does not retry deterministic, attestation, or unknown failures", () => {
    for (const output of [
      "node-gyp rebuild failed for node-pty",
      "package attestation failed: native inventory mismatch",
      "electron-builder exited with code 1",
    ]) {
      expect(classifyElectronBuilderFailure(output)).toMatchObject({
        retryable: false,
      });
    }
  });

  it("stops after three attempts and retains bounded diagnostics", async () => {
    const attempts = [];
    await expect(
      runElectronBuilderWithRetry({
        maxAttempts: 3,
        diagnosticLimitBytes: 64,
        runAttempt: (attempt) => {
          attempts.push(attempt);
          return {
            status: 1,
            output:
              `https://github.com/electron/electron/releases/download/v35.7.5/electron.zip EOF ${"x".repeat(200)}`,
          };
        },
      }),
    ).rejects.toThrowError(/attempt 3\/3/);
    expect(attempts).toEqual([1, 2, 3]);
    try {
      await runElectronBuilderWithRetry({
        maxAttempts: 3,
        diagnosticLimitBytes: 64,
        runAttempt: () => ({
          status: 1,
          output:
            "https://github.com/electron/electron/releases/download/v35.7.5/electron.zip EOF " +
            "y".repeat(200),
        }),
      });
    } catch (error) {
      expect(Buffer.byteLength(error.diagnostics)).toBeLessThanOrEqual(64);
    }
  });

  it("uses supplied classification when the bounded output tail omits the Electron URL", async () => {
    const attempts = [];
    const result = await runElectronBuilderWithRetry({
      maxAttempts: 3,
      diagnosticLimitBytes: 64,
      runAttempt: (attempt) => {
        attempts.push(attempt);
        if (attempt === 2) return { status: 0, output: "complete" };
        return {
          status: 1,
          output:
            "https://github.com/electron/electron/releases/download/v35.7.5/electron.zip EOF " +
            "x".repeat(200),
          classification: {
            retryable: true,
            reason: "transient-electron-download-failure",
          },
        };
      },
    });

    expect(result).toMatchObject({ status: 0 });
    expect(attempts).toEqual([1, 2]);
  });
});

describe("desktop packaging workflow contract", () => {
  it("uses one reusable target path for Nightly, Stable, and PR", () => {
    for (const workflow of [
      ".github/workflows/nightly-desktop.yml",
      ".github/workflows/build-release.yml",
      ".github/workflows/desktop-package-dry-run.yml",
    ]) {
      const source = readFileSync(path.join(repoRoot, workflow), "utf8");
      expect(source).toContain("./.github/workflows/desktop-package-target.yml");
    }
    const nightly = readFileSync(
      path.join(repoRoot, ".github/workflows/nightly-desktop.yml"),
      "utf8",
    );
    expect(nightly).not.toMatch(/bun (run --cwd apps\/desktop build|apps\/desktop\/scripts\/(ci-package|smoke-test|ensure-sdk))/);
    expect(nightly).toContain("signing-required: false");
    expect(nightly).toContain("terminal-release-evidence.mjs aggregate");
  });

  it("keeps every channel matrix equal to the canonical target inventory", () => {
    const matrices = assertDesktopWorkflowMatrices({
      nightly: readFileSync(
        path.join(repoRoot, ".github/workflows/nightly-desktop.yml"),
        "utf8",
      ),
      stable: readFileSync(
        path.join(repoRoot, ".github/workflows/build-release.yml"),
        "utf8",
      ),
      "pull-request": readFileSync(
        path.join(repoRoot, ".github/workflows/desktop-package-dry-run.yml"),
        "utf8",
      ),
    });
    const expected = SUPPORTED_DESKTOP_TARGETS.map(({ id }) => id).sort();

    for (const targets of Object.values(matrices)) {
      expect(targets.map(({ id }) => id).sort()).toEqual(expected);
    }
  });

  it("skips same-commit Nightly only when all release manifests exist", () => {
    const nightly = readFileSync(
      path.join(repoRoot, ".github/workflows/nightly-desktop.yml"),
      "utf8",
    );
    expect(nightly).toContain(
      'if grep -Fxq "nightly.yml" <<< "$assets" && grep -Fxq "nightly-linux.yml" <<< "$assets" && grep -Fxq "nightly-mac.yml" <<< "$assets" && grep -Fxq "terminal-release-manifest.json" <<< "$assets"; then',
    );
  });

  it("keeps the Nightly tag jq regex escaped for gh", () => {
    const nightly = readFileSync(
      path.join(repoRoot, ".github/workflows/nightly-desktop.yml"),
      "utf8",
    );
    expect(nightly).toContain(String.raw`test("^v.*-nightly\\.")`);
    expect(nightly).not.toContain(String.raw`test("^v.*-nightly\.")`);
  });

  it("passes the Nightly channel and prerelease version to every target", () => {
    const nightly = readFileSync(
      path.join(repoRoot, ".github/workflows/nightly-desktop.yml"),
      "utf8",
    );
    expect(nightly).toContain("compute-nightly-version.mjs");
    expect(nightly).toContain("version: ${{ needs.setup.outputs.version }}");
    expect(
      nightly.match(/--config\.publish\.channel=nightly/g),
    ).toHaveLength(4);
    expect(nightly).toContain(
      "build-args: --config.publish.channel=nightly",
    );
    expect(nightly).toContain(
      "build-args: --mac --arm64 --config.publish.channel=nightly",
    );
    expect(nightly).toContain(
      "build-args: --mac --x64 --config.publish.channel=nightly",
    );
    expect(nightly).toContain(
      "staged/desktop-target-macos-arm64/nightly-mac.yml",
    );
    expect(nightly).toContain(
      "staged/desktop-target-macos-x64/nightly-mac.yml",
    );
    expect(nightly).toContain("staged/nightly-mac.yml");
    expect(nightly).toContain(
      "for required in nightly.yml nightly-linux.yml nightly-mac.yml terminal-release-manifest.json; do",
    );
  });

  it("keeps unsigned packaging isolated from signing secrets", () => {
    const workflow = readFileSync(
      path.join(repoRoot, ".github/workflows/desktop-package-target.yml"),
      "utf8",
    );
    const unsignedBlock = workflow.match(
      /- name: Package unsigned target\r?\n([\s\S]*?)(?=\r?\n      - name:)/,
    )?.[1];
    const signedBlock = workflow.match(
      /- name: Package and sign target\r?\n([\s\S]*?)(?=\r?\n      - name:)/,
    )?.[1];

    expect(unsignedBlock).toBeDefined();
    expect(unsignedBlock).toContain("if: inputs.signing-required == false");
    expect(unsignedBlock).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    for (const variable of [
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
    ]) {
      expect(unsignedBlock).not.toContain(`${variable}:`);
    }

    expect(signedBlock).toBeDefined();
    expect(signedBlock).toContain("if: inputs.signing-required");
    expect(signedBlock).toContain("CSC_LINK: ${{ secrets.CSC_LINK }}");
    expect(signedBlock).toContain(
      "CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}",
    );
    expect(signedBlock).toContain(
      "APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}",
    );
    expect(signedBlock).toContain(
      "APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}",
    );
    expect(signedBlock).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "true"');
    expect(signedBlock).toContain("--config.mac.notarize=true");
  });

  it("requires the complete four-target matrix in PR dry-run", () => {
    const source = readFileSync(
      path.join(repoRoot, ".github/workflows/desktop-package-dry-run.yml"),
      "utf8",
    );
    for (const target of ["windows-x64", "linux-x64", "macos-arm64", "macos-x64"]) {
      expect(source).toContain(target);
    }
    expect(source).toContain("needs: package");
    expect(source).toContain("--channel pull-request");
  });

  it("uses gzip only for the Linux PR package", () => {
    const source = readFileSync(
      path.join(repoRoot, ".github/workflows/desktop-package-dry-run.yml"),
      "utf8",
    );
    const buildArgsFor = (targetId) => {
      const targetBlock = source.match(
        new RegExp(
          `- target-id: ${targetId}\\r?\\n(?<body>[\\s\\S]*?)(?=\\r?\\n\\s+- target-id:|\\r?\\n\\s+uses:)`,
        ),
      )?.groups?.body;
      expect(targetBlock).toBeDefined();
      return targetBlock.match(/^\s+build-args:\s*(?<value>[^\r\n]*)$/m)?.groups
        ?.value.trim();
    };

    expect(buildArgsFor("linux-x64")).toBe("--config.deb.compression=gz");
    expect(buildArgsFor("windows-x64")).toBe('""');
    expect(buildArgsFor("macos-arm64")).toBe("--mac --arm64");
    expect(buildArgsFor("macos-x64")).toBe("--mac --x64");
  });

  it("keeps Terminal attestation out of afterPack", () => {
    const afterPack = readFileSync(
      path.join(repoRoot, "apps/desktop/scripts/desktop-packaging/target-package/after-pack.mjs"),
      "utf8",
    );
    expect(afterPack).not.toContain("MCODE" + "_SKIP_TERMINAL_ATTESTATION");
    expect(afterPack).not.toContain("attestPackagedTerminalArtifacts");
    expect(afterPack).toContain("retainTargetTerminalNativeArtifacts");
  });
});
