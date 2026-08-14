import { describe, expect, it } from "vitest";
import {
  TerminalReleaseEvidenceManifestSchema,
  TerminalTargetEvidenceManifestSchema,
  TerminalDiagnosticEventSchema,
  TerminalDiagnosticsBundleSchema,
  TerminalProductSmokeEvidenceSchema,
  TerminalProductSmokeReceiptSchema,
} from "../terminal-diagnostics.js";

const UUID = "11111111-1111-4111-8111-111111111111";

function productEvidenceFixture() {
  const renderer = {
    cols: 80,
    rows: 24,
    cursor: { x: 1, y: 1 },
    lines: [{ text: "marker", wrapped: false }],
    normalizedLines: ["marker"],
  };
  const base = {
    contractVersion: 1,
    kind: "packaged-terminal-product-smoke",
    generatedAt: "2026-08-14T12:00:00.000Z",
    status: "passed",
    startupFallbackDurationMs: null,
    isolation: { mode: "linux-network-namespace", loopbackAllowed: true },
    renderer,
    workload: { id: "process-cleanup", synchronizationMarker: "WF:cleanup:parent" },
    cleanup: { pids: [1, 2, 3], hostPids: [3], aliveAfterCleanup: [], cleanupDurationMs: 10, passed: true },
    packageHashesBefore: { "resources/app.asar": "a".repeat(64) },
    packageHashesAfter: { "resources/app.asar": "a".repeat(64) },
  } as const;
  const modern = { contractVersion: 1, backend: "modern" as const, host: { state: "healthy", generation: "1" }, releaseTest: { hostPid: 3 } };
  const clean = { ...base, fault: null, observations: { capabilities: { initial: modern, history: [modern] }, sessions: [], retry: null, newSession: null, typedErrors: [] } };
    const startup = (fault: "startup-health-failure" | "missing-native-artifact") => ({
    ...base,
    fault,
    startupFallbackDurationMs: 1200,
    observations: {
      capabilities: { initial: { contractVersion: 0, backend: "legacy" as const }, history: [{ contractVersion: 0, backend: "legacy" as const }] },
      sessions: [],
      retry: modern,
      newSession: { sessionId: "22222222-2222-4222-8222-222222222222", state: "running", hostGeneration: "2", exitReason: null },
      typedErrors: [],
    },
  });
  const recovery = (fault: "post-start-host-exit" | "containment-failure") => ({
    ...base,
    fault,
    startupFallbackDurationMs: null,
    observations: {
      capabilities: {
        initial: modern,
        history: [modern, { ...modern, host: { state: "healthy", generation: "2" } }],
      },
      sessions: [{ sessionId: UUID, state: "failed", hostGeneration: "1", exitReason: "host-crash" }],
      retry: null,
      newSession: { sessionId: "22222222-2222-4222-8222-222222222222", state: "running", hostGeneration: "2", exitReason: null },
      typedErrors: ["HOST_UNHEALTHY"],
    },
  });
  return { clean, faults: [startup("startup-health-failure"), recovery("post-start-host-exit"), recovery("containment-failure"), startup("missing-native-artifact")] };
}

describe("Terminal v1 diagnostics", () => {
  it("requires complete bounded product smoke outcomes", () => {
    const receipt = {
      contractVersion: 1,
      kind: "packaged-terminal-product-smoke",
      generatedAt: "2026-08-14T12:00:00.000Z",
      status: "passed",
      fault: "post-start-host-exit",
      startupFallbackDurationMs: null,
      observations: {
        capabilities: {
          initial: { contractVersion: 1, backend: "modern", host: { state: "healthy", generation: "1" }, releaseTest: { hostPid: 3 } },
          history: [
            { contractVersion: 1, backend: "modern", host: { state: "unhealthy", generation: "1" }, releaseTest: { hostPid: 3 } },
            { contractVersion: 1, backend: "modern", host: { state: "healthy", generation: "2" }, releaseTest: { hostPid: 4 } },
          ],
        },
        sessions: [
          { sessionId: UUID, state: "failed", hostGeneration: "1", exitReason: "host-crash" },
          { sessionId: "22222222-2222-4222-8222-222222222222", state: "running", hostGeneration: "2", exitReason: null },
        ],
        retry: null,
        newSession: { sessionId: "22222222-2222-4222-8222-222222222222", state: "running", hostGeneration: "2", exitReason: null },
        typedErrors: ["HOST_UNHEALTHY"],
      },
      isolation: {
        mode: "linux-network-namespace",
        loopbackAllowed: true,
      },
      renderer: {
        cols: 80,
        rows: 24,
        cursor: { x: 1, y: 1 },
        lines: [{ text: "marker", wrapped: false }],
        normalizedLines: ["marker"],
      },
      workload: {
        id: "process-cleanup",
        synchronizationMarker: "WF:cleanup:parent",
      },
      cleanup: {
        pids: [1, 2, 3, 4],
        hostPids: [3, 4],
        aliveAfterCleanup: [],
        cleanupDurationMs: 10,
        passed: true,
      },
      packageHashesBefore: { "resources/app.asar": "a".repeat(64) },
      packageHashesAfter: { "resources/app.asar": "a".repeat(64) },
    } as const;
    expect(TerminalProductSmokeReceiptSchema().parse(receipt)).toEqual(receipt);
    expect(() =>
      TerminalProductSmokeReceiptSchema().parse({
        ...receipt,
        observations: { ...receipt.observations, capabilities: { ...receipt.observations.capabilities, history: [receipt.observations.capabilities.history[0]] } },
      }),
    ).toThrow();
    expect(() =>
      TerminalProductSmokeReceiptSchema().parse({
        ...receipt,
        fault: "startup-health-failure",
        startupFallbackDurationMs: 5_001,
        observations: {
          ...receipt.observations,
          capabilities: {
            initial: { contractVersion: 0, backend: "legacy" },
            history: [{ contractVersion: 0, backend: "legacy" }],
          },
          sessions: [],
          retry: { contractVersion: 1, backend: "modern", host: { state: "healthy", generation: "1" }, releaseTest: { hostPid: 3 } },
          newSession: null,
          typedErrors: [],
        },
      }),
    ).toThrow();
    expect(() =>
      TerminalProductSmokeReceiptSchema().parse({
        ...receipt,
        cleanup: { ...receipt.cleanup, hostPids: [999] },
      }),
    ).toThrow();
    expect(() =>
      TerminalProductSmokeReceiptSchema().parse({
        ...receipt,
        cleanup: { ...receipt.cleanup, pids: [1, 2, 3], hostPids: [3] },
      }),
    ).toThrow();
    expect(
      TerminalProductSmokeEvidenceSchema().parse({
        clean: { ...receipt, fault: null, cleanup: { ...receipt.cleanup, pids: [1, 2, 3], hostPids: [3] }, observations: {
          ...receipt.observations,
          capabilities: { initial: receipt.observations.capabilities.initial, history: [receipt.observations.capabilities.initial] },
          sessions: [], retry: null, newSession: null, typedErrors: [],
        } },
        faults: [
          receipt,
          { ...receipt, fault: "startup-health-failure", startupFallbackDurationMs: 1200, cleanup: { ...receipt.cleanup, pids: [1, 2, 3], hostPids: [3] }, observations: {
            ...receipt.observations,
            capabilities: { initial: { contractVersion: 0, backend: "legacy" }, history: [{ contractVersion: 0, backend: "legacy" }] },
            sessions: [], retry: { contractVersion: 1, backend: "modern", host: { state: "healthy", generation: "1" }, releaseTest: { hostPid: 3 } }, newSession: null, typedErrors: [],
          } },
          { ...receipt, fault: "containment-failure" },
          { ...receipt, fault: "missing-native-artifact", startupFallbackDurationMs: 1200, cleanup: { ...receipt.cleanup, pids: [1, 2, 3], hostPids: [3] }, observations: {
            ...receipt.observations,
            capabilities: { initial: { contractVersion: 0, backend: "legacy" }, history: [{ contractVersion: 0, backend: "legacy" }] },
            sessions: [], retry: { contractVersion: 1, backend: "modern", host: { state: "healthy", generation: "1" }, releaseTest: { hostPid: 3 } }, newSession: null, typedErrors: [],
          } },
        ],
      }),
    ).toBeTruthy();
  });

  it("requires both startup-fault host PIDs in cleanup evidence", () => {
    const base = productEvidenceFixture().faults[0];
    const receipt = {
      ...base,
      observations: {
        capabilities: {
          initial: { contractVersion: 0, backend: "legacy" as const, releaseTest: { hostPid: 7 } },
          history: [{ contractVersion: 0, backend: "legacy" as const, releaseTest: { hostPid: 7 } }],
        },
        sessions: [],
        retry: {
          contractVersion: 1,
          backend: "modern" as const,
          host: { state: "healthy", generation: "1" },
          releaseTest: { hostPid: 8 },
        },
        newSession: null,
        typedErrors: [],
      },
      cleanup: { ...base.cleanup, pids: [1, 7, 8], hostPids: [7, 8] },
    } as const;

    expect(TerminalProductSmokeReceiptSchema().parse(receipt)).toEqual(receipt);
    expect(() =>
      TerminalProductSmokeReceiptSchema().parse({
        ...receipt,
        cleanup: { ...receipt.cleanup, pids: [1, 7], hostPids: [7] },
      }),
    ).toThrow();
  });

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
      terminalProduct: productEvidenceFixture(),
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
      terminalProduct: productEvidenceFixture(),
    } as const;

    expect(() =>
      TerminalTargetEvidenceManifestSchema().parse(source),
    ).toThrow();
  });
});
