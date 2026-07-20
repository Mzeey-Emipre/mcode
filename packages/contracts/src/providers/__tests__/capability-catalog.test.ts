import { describe, expect, it } from "vitest";
import {
  PROVIDER_CATALOG_PATH_MAX_CHARS,
  ProviderCatalogRequestSchema,
  ProviderCatalogSnapshotSchema,
} from "../../index.js";

const fetchedAt = "2026-07-20T12:00:00.000Z";

function entry(kind: "skill" | "plugin" | "customPrompt" | "providerCommand") {
  const base = {
    kind,
    identity: { providerId: "codex", kind, nativeId: "same-name" },
    name: "same-name",
    description: `${kind} description`,
  } as const;
  return kind === "skill" ? { ...base, source: "user" as const } : base;
}

describe("ProviderCatalogSnapshotSchema", () => {
  it("accepts every capability discriminator with distinct same-name identities", () => {
    const entries = [
      entry("skill"),
      entry("plugin"),
      entry("customPrompt"),
      entry("providerCommand"),
    ];

    const snapshot = ProviderCatalogSnapshotSchema().parse({
      providerId: "codex",
      context: { scope: "workspace", workspaceId: "workspace-1", threadId: "thread-1" },
      freshness: { status: "fresh", fetchedAt },
      diagnostics: [],
      entries,
      selectableAgents: [],
    });

    expect(snapshot.entries.map((item) => item.kind)).toEqual([
      "skill",
      "plugin",
      "customPrompt",
      "providerCommand",
    ]);
    expect(new Set(snapshot.entries.map((item) => JSON.stringify(item.identity))).size).toBe(4);
  });

  it("keeps selectable agents and diagnostics outside invocable entries", () => {
    const snapshot = ProviderCatalogSnapshotSchema().parse({
      providerId: "codex",
      context: { scope: "user" },
      freshness: { status: "stale", fetchedAt, reason: "Refresh failed" },
      diagnostics: [{
        severity: "warning",
        code: "source-unavailable",
        message: "The provider source is unavailable.",
      }],
      entries: [entry("skill")],
      selectableAgents: [{
        providerId: "codex",
        nativeId: "reviewer",
        name: "reviewer",
        path: "C:/catalog/agents/reviewer.toml",
        description: "Reviews changes",
      }],
    });

    expect(snapshot.selectableAgents).toHaveLength(1);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.diagnostics[0]?.code).toBe("source-unavailable");
    expect(snapshot.freshness.status).toBe("stale");
  });

  it("rejects entry identities owned by another provider", () => {
    expect(ProviderCatalogSnapshotSchema().safeParse({
      providerId: "claude",
      context: { scope: "user" },
      freshness: { status: "fresh", fetchedAt },
      diagnostics: [],
      entries: [entry("skill")],
      selectableAgents: [],
    }).success).toBe(false);
  });
});

describe("ProviderCatalogRequestSchema", () => {
  it("accepts user, workspace, and bounded path discovery contexts", () => {
    expect(ProviderCatalogRequestSchema().parse({ providerId: "claude" })).toEqual({
      providerId: "claude",
    });
    expect(ProviderCatalogRequestSchema().parse({
      providerId: "codex",
      workspaceId: "workspace-1",
      threadId: "thread-1",
    })).toMatchObject({ workspaceId: "workspace-1", threadId: "thread-1" });
    expect(ProviderCatalogRequestSchema().parse({ providerId: "cursor", cwd: "C:/repo" }))
      .toMatchObject({ cwd: "C:/repo" });
  });

  it("rejects unknown providers and malformed or oversized contexts", () => {
    expect(ProviderCatalogRequestSchema().safeParse({ providerId: "unknown" }).success).toBe(false);
    expect(ProviderCatalogRequestSchema().safeParse({
      providerId: "codex",
      threadId: "thread-1",
    }).success).toBe(false);
    expect(ProviderCatalogRequestSchema().safeParse({
      providerId: "codex",
      workspaceId: "workspace-1",
      cwd: "C:/repo",
    }).success).toBe(false);
    expect(ProviderCatalogRequestSchema().safeParse({
      providerId: "codex",
      cwd: "x".repeat(PROVIDER_CATALOG_PATH_MAX_CHARS + 1),
    }).success).toBe(false);
  });
});
