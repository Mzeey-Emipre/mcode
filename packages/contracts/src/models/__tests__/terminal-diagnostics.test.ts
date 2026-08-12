import { describe, expect, it } from "vitest";
import {
  TerminalReleaseEvidenceManifestSchema,
  TerminalTargetEvidenceManifestSchema,
  TerminalDiagnosticEventSchema,
  TerminalDiagnosticsBundleSchema,
} from "../terminal-diagnostics.js";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("Terminal v1 diagnostics", () => {
  it("enforces metric units and metric-specific bounds", () => {
    const event = {
      eventId: UUID,
      at: "2026-08-09T12:00:00.000Z",
      metric: "attachment.hydration.ms",
      unit: "ms",
      value: 250,
      outcome: "ok",
      correlationId: "hydrate-1",
    } as const;
    expect(TerminalDiagnosticEventSchema().parse(event)).toEqual(event);
    expect(() =>
      TerminalDiagnosticEventSchema().parse({ ...event, unit: "bytes" }),
    ).toThrow();
    expect(() =>
      TerminalDiagnosticEventSchema().parse({ ...event, value: 600_001 }),
    ).toThrow();
  });

  it("rejects duplicate metrics and unordered histogram percentiles", () => {
    const health = {
      contractVersion: 1,
      state: "healthy",
      hostGeneration: "1",
      activeSessions: 1,
      lastHeartbeatMsAgo: 10,
      queueBytes: 0,
      eventLoopLagMs: 1,
      hostRssBytes: "1024",
    } as const;
    const base = {
      contractVersion: 1,
      generatedAt: "2026-08-09T12:00:00.000Z",
      backend: "modern",
      health,
      events: [],
      counters: [],
      histograms: [],
    } as const;
    expect(TerminalDiagnosticsBundleSchema().parse(base)).toEqual(base);
    expect(() =>
      TerminalDiagnosticsBundleSchema().parse({
        ...base,
        histograms: [
          {
            metric: "session.create.ms",
            unit: "ms",
            count: 1,
            p50: 10,
            p95: 9,
            p99: 12,
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts bounded target and aggregate release evidence", () => {
    const target = {
      contractVersion: 1,
      kind: "terminal-target-evidence",
      generatedAt: "2026-08-12T12:00:00.000Z",
      commit: "a".repeat(40),
      version: "0.13.0-nightly.20260812.1",
      channel: "nightly",
      expectedLegacy: true,
      target: {
        platform: "windows",
        arch: "x64",
        runner: "windows-2025",
        osRelease: "10.0.26100",
        cpuCount: 4,
        memoryBytes: "8589934592",
      },
      versions: {
        electron: "35.7.5",
        node: "24.18.0",
        xterm: "5.5.0",
        ptyHostContract: "1",
      },
      signingRequired: true,
      signatures: [
        { kind: "authenticode", status: "passed", subject: "Mcode.exe" },
      ],
      artifacts: [
        {
          name: "Mcode-Setup.exe",
          kind: "nsis",
          bytes: 10,
          sha256: "b".repeat(64),
        },
        { name: "Mcode.zip", kind: "zip", bytes: 10, sha256: "c".repeat(64) },
      ],
      terminal: {
        contractVersion: 1,
        target: { platform: "win32", arch: "x64", modulesAbi: "127" },
        runtime: { node: "22.18.0", electron: "35.7.5" },
        dependencies: { "node-pty": "1.0.0", koffi: "2.16.1" },
        compressedBytes: 10,
        compressedLimitBytes: 10_485_760,
        packageFileCount: 3,
        artifacts: ["pty-host", "node-pty", "koffi"].map((kind, index) => ({
          kind,
          path: `${kind}.bin`,
          origin: "fixture",
          ...(kind === "pty-host"
            ? {}
            : { architecture: "x64", modulesAbi: "127" }),
          bytes: 10,
          compressedBytes: 10,
          sha256: String(index + 1).repeat(64),
        })),
      },
    } as const;

    expect(TerminalTargetEvidenceManifestSchema().parse(target)).toEqual(
      target,
    );
    expect(
      TerminalReleaseEvidenceManifestSchema().parse({
        contractVersion: 1,
        kind: "terminal-release-evidence",
        generatedAt: target.generatedAt,
        commit: target.commit,
        version: target.version,
        channel: target.channel,
        expectedLegacy: true,
        signingRequired: true,
        nativeDependencies: target.terminal.dependencies,
        targets: [
          {
            targetId: "windows-x64",
            path: "windows-x64/terminal-target-manifest.json",
            sha256: "d".repeat(64),
            artifactCount: 2,
          },
        ],
        artifacts: [],
      }),
    ).toBeTruthy();
  });

  it("rejects duplicate artifacts, unsigned required targets, and duplicate aggregate targets", () => {
    const source = {
      contractVersion: 1,
      kind: "terminal-target-evidence",
      generatedAt: "2026-08-12T12:00:00.000Z",
      commit: "a".repeat(40),
      version: "0.13.0",
      channel: "stable",
      expectedLegacy: false,
      target: {
        platform: "linux",
        arch: "x64",
        runner: "ubuntu-24.04",
        osRelease: "6.8.0",
        cpuCount: 4,
        memoryBytes: "8589934592",
      },
      versions: {
        electron: "35.7.5",
        node: "24.18.0",
        xterm: "5.5.0",
        ptyHostContract: "1",
      },
      signingRequired: true,
      signatures: [
        { kind: "release-key", status: "skipped", subject: "SHA256SUMS.sig" },
      ],
      artifacts: [
        { name: "mcode.deb", kind: "deb", bytes: 10, sha256: "b".repeat(64) },
        {
          name: "mcode.deb",
          kind: "appimage",
          bytes: 10,
          sha256: "c".repeat(64),
        },
      ],
      terminal: {
        contractVersion: 1,
        target: { platform: "linux", arch: "x64", modulesAbi: "127" },
        runtime: { node: "22.18.0", electron: "35.7.5" },
        dependencies: { "node-pty": "1.0.0", koffi: "2.16.1" },
        compressedBytes: 10,
        compressedLimitBytes: 100,
        packageFileCount: 3,
        artifacts: ["pty-host", "node-pty", "koffi"].map((kind, index) => ({
          kind,
          path: `${kind}.bin`,
          origin: "fixture",
          bytes: 10,
          compressedBytes: 10,
          sha256: String(index + 1).repeat(64),
        })),
      },
    } as const;

    expect(() =>
      TerminalTargetEvidenceManifestSchema().parse(source),
    ).toThrow();
  });
});
