import { describe, expect, it } from "vitest";
import {
  PROVIDER_CATALOG_MAX_ENTRIES,
  PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS,
  type SelectableProviderAgent,
  type SkillInfo,
} from "@mcode/contracts";
import { buildProviderCatalogSnapshot } from "../provider-catalog.js";

function skill(index: number): SkillInfo {
  return {
    name: `skill-${index}`,
    description: `Skill ${index}`,
    kind: "skill",
    source: "user",
    providers: ["codex"],
  };
}

function agent(index: number): SelectableProviderAgent {
  return {
    providerId: "codex",
    nativeId: `agent-${index}`,
    name: `agent-${index}`,
    path: `C:/agents/agent-${index}.toml`,
  };
}

describe("provider catalog bounds", () => {
  it("caps snapshot entries and selectable agents with typed diagnostics", () => {
    const snapshot = buildProviderCatalogSnapshot({
      providerId: "codex",
      context: { scope: "user" },
      skills: Array.from({ length: PROVIDER_CATALOG_MAX_ENTRIES + 1 }, (_, index) => skill(index)),
      agents: Array.from(
        { length: PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS + 1 },
        (_, index) => agent(index),
      ),
      fetchedAt: "2026-07-20T12:00:00.000Z",
    });

    expect(snapshot.entries).toHaveLength(PROVIDER_CATALOG_MAX_ENTRIES);
    expect(snapshot.selectableAgents).toHaveLength(PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS);
    expect(snapshot.diagnostics).toHaveLength(2);
    expect(snapshot.diagnostics.every((item) => (
      item.severity === "warning" && item.code === "partial-result"
    ))).toBe(true);
  });

  it("omits an oversized Skill while retaining valid siblings", () => {
    const snapshot = buildProviderCatalogSnapshot({
      providerId: "codex",
      context: { scope: "user" },
      skills: [skill(1), { ...skill(2), description: "x".repeat(2_001) }, skill(3)],
      fetchedAt: "2026-07-20T12:00:00.000Z",
    });

    expect(snapshot.entries.map((entry) => entry.name)).toEqual(["skill-1", "skill-3"]);
    expect(snapshot.diagnostics).toContainEqual({
      providerId: "codex",
      context: { scope: "user" },
      sourceKind: "providerCatalog",
      rejectedSource: "metadata",
      severity: "warning",
      code: "partial-result",
      message: "Some provider catalog items were omitted because their metadata was invalid.",
    });
  });

  it("does not classify a project command as a Codex custom prompt by name", () => {
    const snapshot = buildProviderCatalogSnapshot({
      providerId: "codex",
      context: { scope: "user" },
      skills: [{
        name: "prompts:release",
        nativeName: "prompts:release",
        description: "Project command",
        kind: "command",
        source: "project",
        providers: ["codex"],
        path: "C:/repo/.agents/commands/prompts:release.md",
      }],
      fetchedAt: "2026-07-20T12:00:00.000Z",
    });

    expect(snapshot.entries).toEqual([
      expect.objectContaining({ kind: "providerCommand", name: "prompts:release" }),
    ]);
  });

  it("omits an invalid selectable agent while retaining valid siblings", () => {
    const snapshot = buildProviderCatalogSnapshot({
      providerId: "codex",
      context: { scope: "user" },
      skills: [],
      agents: [
        agent(1),
        { providerId: "codex", nativeId: "invalid", name: "", path: "C:/agents/invalid.toml" },
        agent(3),
      ],
      fetchedAt: "2026-07-20T12:00:00.000Z",
    });

    expect(snapshot.selectableAgents.map((item) => item.name)).toEqual(["agent-1", "agent-3"]);
    expect(snapshot.diagnostics).toContainEqual({
      providerId: "codex",
      context: { scope: "user" },
      sourceKind: "providerCatalog",
      rejectedSource: "metadata",
      severity: "warning",
      code: "partial-result",
      message: "Some provider catalog items were omitted because their metadata was invalid.",
    });
  });

  it("schema-validates the final bounded snapshot", () => {
    expect(() => buildProviderCatalogSnapshot({
      providerId: "codex",
      context: { scope: "user" },
      skills: [],
      fetchedAt: "invalid-date",
    })).toThrow();
  });
});
