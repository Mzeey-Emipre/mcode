import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_CONFORMANCE_REPLAY_DIRECTORY,
  BROWSER_CONFORMANCE_REPLAY_MAX_BYTES,
  createBrowserConformanceReplayBundle,
  createBrowserConformanceResourceSnapshot,
  createBrowserConformanceScenario,
  createBrowserConformanceSchedule,
  normalizeBrowserConformanceRun,
  sanitizeBrowserConformanceValue,
  serializeBrowserConformanceReplayBundle,
  writeBrowserConformanceReplayBundle,
} from "../index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => NodeFSPromises.rm(root, { recursive: true, force: true })));
});

function createReplayInput() {
  const scenario = createBrowserConformanceScenario({
    id: "takeover-race",
    seed: 42,
    commands: [{ id: "command-1", operation: "act", args: { typedText: "secret" } }],
    schedule: createBrowserConformanceSchedule({ seed: 42, maxCommands: 1, maxEvents: 2, eventCount: 1 }),
    cleanup: { baseline: createBrowserConformanceResourceSnapshot() },
  });
  return {
    scenario,
    run: normalizeBrowserConformanceRun({
      receipts: [{ order: { tick: 1, ordinal: 0 }, commandId: "command-1", operation: "act", status: "interrupted", effect: "partial", recovery: "yield_to_user", errorCode: "USER_TAKEOVER", errorStage: "effect", ownership: "user", revisions: { control: 2 } }],
      outcome: { status: "interrupted", effect: "partial", recovery: "yield_to_user", errorCode: "USER_TAKEOVER", errorStage: "effect", ownership: "user", revisions: { control: 2 } },
      finalState: { readiness: "human-control", controlOwner: "user", currentUrl: "https://example.test/app?token=secret", resources: {} },
    }),
    cleanup: {
      baseline: createBrowserConformanceResourceSnapshot(),
      final: createBrowserConformanceResourceSnapshot(),
    },
    failingInvariant: "no-late-state-resurrection",
  };
}

describe("Browser conformance replay bundles", () => {
  it("degrades maximal runs deterministically while preserving required replay identity", () => {
    const input = createReplayInput();
    const maximal = {
      ...input,
      run: {
        ...input.run,
        receipts: Array.from({ length: 256 }, (_, index) => ({
          ...input.run.receipts[0],
          order: { tick: index, ordinal: index },
        })),
        visibleObservations: Array.from({ length: 256 }, () => input.run.visibleObservations[0] ?? {
          surface: "browser" as const,
          readiness: "ready" as const,
          controlOwner: "none" as const,
          tabCount: 0,
          currentUrl: null,
          title: "observation",
          action: null,
          truncated: false,
        }),
      },
    };
    const bundle = createBrowserConformanceReplayBundle(maximal);
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.generatorVersion).toBe("browser-v2-seeded-v1");
    expect(bundle.scenarioId).toBe("takeover-race");
    expect(bundle.seed).toBe(42);
    expect(bundle.failingInvariant).toBe("no-late-state-resurrection");
    expect(new TextEncoder().encode(serializeBrowserConformanceReplayBundle(bundle)).byteLength)
      .toBeLessThanOrEqual(BROWSER_CONFORMANCE_REPLAY_MAX_BYTES);
  });

  it("sanitizes sensitive payloads and preserves the seed and failing invariant", () => {
    const bundle = createBrowserConformanceReplayBundle(createReplayInput());
    const serialized = serializeBrowserConformanceReplayBundle(bundle);

    expect(bundle.seed).toBe(42);
    expect(bundle.failingInvariant).toBe("no-late-state-resurrection");
    expect(serialized).not.toContain("typedText");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("args");
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(BROWSER_CONFORMANCE_REPLAY_MAX_BYTES);
  });

  it("sanitizes URLs and credential-shaped text in the invariant label", () => {
    const input = createReplayInput();
    const bundle = createBrowserConformanceReplayBundle({
      ...input,
      failingInvariant: "see https://example.test/path?token=secret#fragment token=secret",
    });
    expect(bundle.failingInvariant).toContain("https://example.test/path");
    expect(bundle.failingInvariant).not.toContain("token=secret");
    expect(bundle.failingInvariant).not.toContain("#fragment");
  });

  it("bounds generic sanitization and writes only below disposable verification", async () => {
    const sanitized = sanitizeBrowserConformanceValue({
      requestId: "dynamic",
      headers: { authorization: "secret" },
      body: "raw body",
      typedText: "raw typed content",
      screenshotData: "raw screenshot bytes",
      location: "https://example.test/path?token=secret#fragment",
      nested: Array.from({ length: 1_000 }, () => "x"),
    });
    expect(JSON.stringify(sanitized)).not.toContain("dynamic");
    expect(JSON.stringify(sanitized)).not.toContain("raw body");
    expect(JSON.stringify(sanitized)).not.toContain("raw typed content");
    expect(JSON.stringify(sanitized)).not.toContain("raw screenshot bytes");
    expect(JSON.stringify(sanitized)).not.toContain("secret");
    expect((sanitized as { nested: readonly unknown[] }).nested).toHaveLength(128);

    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-browser-conformance-"));
    temporaryRoots.push(root);
    const path = await writeBrowserConformanceReplayBundle(createBrowserConformanceReplayBundle(createReplayInput()), { workspaceRoot: root });
    expect(path.startsWith(NodePath.join(root, BROWSER_CONFORMANCE_REPLAY_DIRECTORY))).toBe(true);
    expect(JSON.parse(await NodeFSPromises.readFile(path, "utf8")).seed).toBe(42);
  });
});
