import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_CATALOG_MAX_ENTRIES,
  PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS,
  type ProviderAgentMention,
  type SkillInfo,
} from "@mcode/contracts";
import {
  buildProviderCatalogSnapshot,
  discoverBoundedCodexAgents,
} from "./provider-catalog.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcode-provider-catalog-"));
  temporaryDirectories.push(directory);
  return directory;
}

function skill(index: number): SkillInfo {
  return {
    name: `skill-${index}`,
    description: `Skill ${index}`,
    kind: "skill",
    source: "user",
    providers: ["codex"],
  };
}

function agent(index: number): ProviderAgentMention {
  return { name: `agent-${index}`, path: `C:/agents/agent-${index}.toml` };
}

describe("provider catalog bounds", () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(
      (directory) => rm(directory, { recursive: true, force: true }),
    ));
  });

  it("bounds Codex agent file count and per-file reads", async () => {
    const directory = await createTemporaryDirectory();
    await Promise.all([
      writeFile(join(directory, "one.toml"), 'name = "one"'),
      writeFile(join(directory, "two.toml"), 'name = "two"'),
      writeFile(join(directory, "three.toml"), 'name = "three"'),
    ]);

    const fileCountResult = await discoverBoundedCodexAgents(
      [directory],
      { maxFiles: 2, maxFileBytes: 64 },
    );
    expect(fileCountResult.agents).toHaveLength(2);
    expect(fileCountResult.limits).toEqual({ fileCount: true, fileSize: false });

    const fileSizeResult = await discoverBoundedCodexAgents(
      [directory],
      { maxFiles: 3, maxFileBytes: 8 },
    );
    expect(fileSizeResult.agents).toEqual([]);
    expect(fileSizeResult.limits).toEqual({ fileCount: false, fileSize: true });
  });

  it("caps snapshot entries and selectable agents with typed diagnostics", () => {
    const snapshot = buildProviderCatalogSnapshot({
      providerId: "codex",
      context: { scope: "user" },
      skills: Array.from({ length: PROVIDER_CATALOG_MAX_ENTRIES + 1 }, (_, index) => skill(index)),
      agentDiscovery: {
        agents: Array.from(
          { length: PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS + 1 },
          (_, index) => agent(index),
        ),
        limits: { fileCount: true, fileSize: true },
      },
      fetchedAt: "2026-07-20T12:00:00.000Z",
    });

    expect(snapshot.entries).toHaveLength(PROVIDER_CATALOG_MAX_ENTRIES);
    expect(snapshot.selectableAgents).toHaveLength(PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS);
    expect(snapshot.diagnostics).toHaveLength(4);
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
      agentDiscovery: {
        agents: [
          agent(1),
          { name: "", path: "C:/agents/invalid.toml" },
          agent(3),
        ],
        limits: { fileCount: false, fileSize: false },
      },
      fetchedAt: "2026-07-20T12:00:00.000Z",
    });

    expect(snapshot.selectableAgents.map((item) => item.name)).toEqual(["agent-1", "agent-3"]);
    expect(snapshot.diagnostics).toContainEqual({
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
