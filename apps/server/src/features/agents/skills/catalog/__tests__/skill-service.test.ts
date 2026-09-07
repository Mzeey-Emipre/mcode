import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { SkillService, codexPluginNameFromSkillPath } from "../skill-service.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => process.env["HOME"] ?? actual.homedir() };
});

function tmp(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "skill-svc-"));
}

function writeMd(path: string, frontmatter: Record<string, string>, body = "") {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  NodeFS.writeFileSync(path, `---\n${fm}\n---\n${body}`);
}

describe("SkillService", () => {
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalAppData: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = tmp();
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalAppData = process.env.APPDATA;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome; // Windows
    process.env.APPDATA = NodePath.join(fakeHome, "AppData", "Roaming"); // Windows Copilot path
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
    else delete process.env.USERPROFILE;
    if (originalAppData !== undefined) process.env.APPDATA = originalAppData;
    else delete process.env.APPDATA;
    NodeFS.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("scans commands/*.md as command-kind entries", () => {
    const cmdDir = NodePath.join(fakeHome, ".claude", "plugins", "cache", "mp", "superpowers", "5.0.7", "commands");
    NodeFS.mkdirSync(cmdDir, { recursive: true });
    writeMd(NodePath.join(cmdDir, "brainstorm.md"), { description: "Brainstorm an idea" });

    const svc = new SkillService();
    const items = svc.list();

    const brainstorm = items.find((i) => i.name === "superpowers:brainstorm");
    expect(brainstorm).toBeDefined();
    expect(brainstorm!.kind).toBe("command");
    expect(brainstorm!.description).toBe("Brainstorm an idea");
    expect(brainstorm!.source).toBe("plugin");
  });

  it("scans plugin skills nested under <version>/.claude/skills", () => {
    const skillDir = NodePath.join(fakeHome, ".claude", "plugins", "cache", "mp", "impeccable", "2.1.1", ".claude", "skills", "audit");
    NodeFS.mkdirSync(skillDir, { recursive: true });
    writeMd(NodePath.join(skillDir, "SKILL.md"), { description: "Run audit checks" });

    const items = new SkillService().list();
    expect(items.find((i) => i.name === "impeccable:audit")).toMatchObject({
      kind: "skill",
      description: "Run audit checks",
    });
  });

  it("scans project-level <cwd>/.claude/commands/*.md", () => {
    const cwd = tmp();
    const cmdDir = NodePath.join(cwd, ".claude", "commands");
    NodeFS.mkdirSync(cmdDir, { recursive: true });
    writeMd(NodePath.join(cmdDir, "deploy.md"), { description: "Deploy to staging" });

    const items = new SkillService().list(cwd);
    const deploy = items.find((i) => i.name === "deploy");
    expect(deploy).toMatchObject({
      kind: "command",
      source: "project",
      description: "Deploy to staging",
    });

    NodeFS.rmSync(cwd, { recursive: true, force: true });
  });

  it("dedupes by name with priority user > project > agent > plugin", () => {
    const userDir = NodePath.join(fakeHome, ".claude", "skills", "shared");
    const pluginDir = NodePath.join(fakeHome, ".claude", "plugins", "cache", "mp", "p", "1.0.0", "skills", "shared");
    NodeFS.mkdirSync(userDir, { recursive: true });
    NodeFS.mkdirSync(pluginDir, { recursive: true });
    writeMd(NodePath.join(userDir, "SKILL.md"), { description: "User wins" });
    writeMd(NodePath.join(pluginDir, "SKILL.md"), { description: "Plugin loses" });

    const items = new SkillService().list();
    const shared = items.find((i) => i.name === "shared");
    expect(shared!.description).toBe("User wins");
    expect(shared!.source).toBe("user");
  });

  it("skips skill subdirs that lack SKILL.md", () => {
    // Two siblings under the user skills root: one is a real skill, the
    // other is a helper folder (e.g., shared utilities, scaffolding scripts).
    // Without the SKILL.md guard, the helper would surface as an empty
    // command in the popup.
    const realDir = NodePath.join(fakeHome, ".claude", "skills", "real-skill");
    const helperDir = NodePath.join(fakeHome, ".claude", "skills", "_helpers");
    NodeFS.mkdirSync(realDir, { recursive: true });
    NodeFS.mkdirSync(helperDir, { recursive: true });
    writeMd(NodePath.join(realDir, "SKILL.md"), { description: "A real skill" });
    // helperDir intentionally has no SKILL.md.

    const items = new SkillService().list();
    expect(items.find((i) => i.name === "real-skill")).toBeDefined();
    expect(items.find((i) => i.name === "_helpers")).toBeUndefined();
  });

  it("returns empty diagnostics with no error when paths are missing", () => {
    const diag = new SkillService().diagnose();
    expect(diag.errors).toEqual([]);
    expect(diag.scanned.every((s) => s.existed === false || s.entries >= 0)).toBe(true);
  });

  it("invokes subscribers on invalidate() and stops after unsubscribe", () => {
    const svc = new SkillService();
    let calls = 0;
    const unsub = svc.subscribe(() => {
      calls++;
    });

    svc.invalidate();
    expect(calls).toBe(1);

    svc.invalidate();
    expect(calls).toBe(2);

    unsub();
    svc.invalidate();
    expect(calls).toBe(2); // unchanged after unsubscribe
  });

  it("isolates subscriber errors so later subscribers still fire", () => {
    const svc = new SkillService();
    let secondFired = false;
    svc.subscribe(() => {
      throw new Error("first subscriber boom");
    });
    svc.subscribe(() => {
      secondFired = true;
    });

    expect(() => svc.invalidate()).not.toThrow();
    expect(secondFired).toBe(true);
  });

  describe("provider-scoped scanning", () => {
    it("tags skills from ~/.claude/skills with providers=['claude']", () => {
      const skillDir = NodePath.join(fakeHome, ".claude", "skills", "my-skill");
      NodeFS.mkdirSync(skillDir, { recursive: true });
      writeMd(NodePath.join(skillDir, "SKILL.md"), { description: "Claude skill" });

      const items = new SkillService().list(undefined, "claude");

      const skill = items.find((i) => i.name === "my-skill");
      expect(skill).toBeDefined();
      expect(skill!.providers).toEqual(["claude"]);
    });

    it("does not expose Codex Skills from the filesystem fallback", () => {
      const skillDir = NodePath.join(fakeHome, ".codex", "skills", "codex-skill");
      NodeFS.mkdirSync(skillDir, { recursive: true });
      writeMd(NodePath.join(skillDir, "SKILL.md"), { description: "Codex skill" });

      const items = new SkillService().list(undefined, "codex");

      expect(items.find((i) => i.name === "codex-skill")).toBeUndefined();
    });

    it("does not scan Codex plugin cache Skills", () => {
      const skillDir = NodePath.join(
        fakeHome,
        ".codex",
        "plugins",
        "cache",
        "openai-bundled",
        "impeccable",
        "2.1.1",
        "skills",
        "audit",
      );
      NodeFS.mkdirSync(skillDir, { recursive: true });
      const skillPath = NodePath.join(skillDir, "SKILL.md");
      writeMd(skillPath, { name: "audit", description: "Run audit checks" });

      const items = new SkillService().list(undefined, "codex");
      expect(items.find((i) => i.name === "impeccable:audit")).toBeUndefined();
    });

    it("does not scan bundled Codex runtime plugin Skills", () => {
      const skillDir = NodePath.join(
        fakeHome,
        ".cache",
        "codex-runtimes",
        "codex-primary-runtime",
        "plugins",
        "openai-primary-runtime",
        "plugins",
        "documents",
        "skills",
        "documents",
      );
      NodeFS.mkdirSync(skillDir, { recursive: true });
      writeMd(NodePath.join(skillDir, "SKILL.md"), { name: "documents", description: "Edit documents" });

      const items = new SkillService().list(undefined, "codex");
      expect(items.find((i) => i.name === "documents:documents")).toBeUndefined();
    });

    it("extracts Codex plugin names from cache and runtime skill paths", () => {
      const cacheSkillPath = NodePath.join(
        fakeHome,
        ".codex",
        "plugins",
        "cache",
        "openai-bundled",
        "browser",
        "1.0.0",
        "skills",
        "control-in-app-browser",
        "SKILL.md",
      );
      const runtimeSkillPath = NodePath.join(
        fakeHome,
        ".cache",
        "codex-runtimes",
        "codex-primary-runtime",
        "plugins",
        "openai-primary-runtime",
        "plugins",
        "documents",
        "skills",
        "documents",
        "SKILL.md",
      );

      expect(codexPluginNameFromSkillPath(cacheSkillPath, fakeHome)).toBe("browser");
      expect(codexPluginNameFromSkillPath(runtimeSkillPath, fakeHome)).toBe("documents");
    });

    it("leaves ~/.agents/skills discovery to the native Codex catalog", () => {
      const skillDir = NodePath.join(fakeHome, ".agents", "skills", "shared-skill");
      NodeFS.mkdirSync(skillDir, { recursive: true });
      writeMd(NodePath.join(skillDir, "SKILL.md"), { description: "Shared skill" });

      const svc = new SkillService();

      const codexItems = svc.list(undefined, "codex");
      expect(codexItems.find((i) => i.name === "shared-skill")).toBeUndefined();

      svc.invalidate();
      const copilotItems = svc.list(undefined, "copilot");
      expect(copilotItems.find((i) => i.name === "shared-skill")).toBeUndefined();

      svc.invalidate();
      const claudeItems = svc.list(undefined, "claude");
      expect(claudeItems.find((i) => i.name === "shared-skill")).toBeUndefined();
    });

    it("filters by providerId and returns only matching skills", () => {
      const claudeSkillDir = NodePath.join(fakeHome, ".claude", "skills", "claude-only");
      NodeFS.mkdirSync(claudeSkillDir, { recursive: true });
      writeMd(NodePath.join(claudeSkillDir, "SKILL.md"), { description: "Claude only" });

      const codexSkillDir = NodePath.join(fakeHome, ".codex", "skills", "codex-only");
      NodeFS.mkdirSync(codexSkillDir, { recursive: true });
      writeMd(NodePath.join(codexSkillDir, "SKILL.md"), { description: "Codex only" });

      const svc = new SkillService();

      const claudeItems = svc.list(undefined, "claude");
      expect(claudeItems.find((i) => i.name === "claude-only")).toBeDefined();
      expect(claudeItems.find((i) => i.name === "codex-only")).toBeUndefined();

      svc.invalidate();
      const codexItems = svc.list(undefined, "codex");
      expect(codexItems.find((i) => i.name === "codex-only")).toBeUndefined();
      expect(codexItems.find((i) => i.name === "claude-only")).toBeUndefined();
    });

    it("returns all skills when no providerId is given", () => {
      const claudeSkillDir = NodePath.join(fakeHome, ".claude", "skills", "claude-skill");
      NodeFS.mkdirSync(claudeSkillDir, { recursive: true });
      writeMd(NodePath.join(claudeSkillDir, "SKILL.md"), { description: "Claude" });

      const codexSkillDir = NodePath.join(fakeHome, ".codex", "skills", "codex-skill");
      NodeFS.mkdirSync(codexSkillDir, { recursive: true });
      writeMd(NodePath.join(codexSkillDir, "SKILL.md"), { description: "Codex" });

      const items = new SkillService().list();

      expect(items.find((i) => i.name === "claude-skill")).toBeDefined();
      expect(items.find((i) => i.name === "codex-skill")).toBeUndefined();
      expect(items.every((i) => Array.isArray(i.providers))).toBe(true);
    });

    it("deduplicates by name within same provider using source priority", () => {
      const cwd = tmp();
      try {
        const userSkillDir = NodePath.join(fakeHome, ".claude", "skills", "shared");
        NodeFS.mkdirSync(userSkillDir, { recursive: true });
        writeMd(NodePath.join(userSkillDir, "SKILL.md"), { description: "User wins" });

        const projectSkillDir = NodePath.join(cwd, ".claude", "skills", "shared");
        NodeFS.mkdirSync(projectSkillDir, { recursive: true });
        writeMd(NodePath.join(projectSkillDir, "SKILL.md"), { description: "Project loses" });

        const items = new SkillService().list(cwd, "claude");
        const shared = items.find((i) => i.name === "shared");
        expect(shared!.description).toBe("User wins");
        expect(shared!.source).toBe("user");
      } finally {
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("leaves Codex custom prompts to the bounded catalog adapter", () => {
      const cmdDir = NodePath.join(fakeHome, ".codex", "prompts");
      NodeFS.mkdirSync(cmdDir, { recursive: true });
      const promptPath = NodePath.join(cmdDir, "deploy.md");
      writeMd(promptPath, { description: "Codex deploy prompt" });

      const items = new SkillService().list(undefined, "codex");

      expect(items.find((i) => i.name === "prompts:deploy")).toBeUndefined();
    });

    it("leaves Codex commands outside the two documented compatibility adapters", () => {
      const userCommands = NodePath.join(fakeHome, ".agents", "commands");
      const cwd = tmp();
      const projectCommands = NodePath.join(cwd, ".agents", "commands");
      NodeFS.mkdirSync(userCommands, { recursive: true });
      NodeFS.mkdirSync(projectCommands, { recursive: true });
      writeMd(NodePath.join(userCommands, "user-command.md"), { description: "Legacy user command" });
      writeMd(NodePath.join(projectCommands, "project-command.md"), {
        description: "Legacy project command",
      });

      try {
        const items = new SkillService().list(cwd, "codex");

        expect(items).toEqual([]);
      } finally {
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("tags skills from ~/.cursor/skills with providers=['cursor']", () => {
      const skillDir = NodePath.join(fakeHome, ".cursor", "skills", "my-cursor-skill");
      NodeFS.mkdirSync(skillDir, { recursive: true });
      writeMd(NodePath.join(skillDir, "SKILL.md"), { description: "Cursor user skill" });

      const items = new SkillService().list(undefined, "cursor");
      const skill = items.find((i) => i.name === "my-cursor-skill");
      expect(skill).toMatchObject({
        kind: "skill",
        source: "user",
        description: "Cursor user skill",
        providers: ["cursor"],
      });
    });

    it("tags commands from ~/.cursor/commands with providers=['cursor']", () => {
      const cmdDir = NodePath.join(fakeHome, ".cursor", "commands");
      NodeFS.mkdirSync(cmdDir, { recursive: true });
      writeMd(NodePath.join(cmdDir, "lint.md"), { description: "Cursor lint command" });

      const items = new SkillService().list(undefined, "cursor");
      const cmd = items.find((i) => i.name === "lint");
      expect(cmd).toMatchObject({
        kind: "command",
        source: "user",
        description: "Cursor lint command",
        providers: ["cursor"],
      });
    });

    it("scans project-level <cwd>/.cursor/skills and commands for cursor", () => {
      const cwd = tmp();
      try {
        const skillDir = NodePath.join(cwd, ".cursor", "skills", "proj-skill");
        NodeFS.mkdirSync(skillDir, { recursive: true });
        writeMd(NodePath.join(skillDir, "SKILL.md"), { description: "Project cursor skill" });

        const cmdDir = NodePath.join(cwd, ".cursor", "commands");
        NodeFS.mkdirSync(cmdDir, { recursive: true });
        writeMd(NodePath.join(cmdDir, "ship.md"), { description: "Ship it" });

        const items = new SkillService().list(cwd, "cursor");
        expect(items.find((i) => i.name === "proj-skill")).toMatchObject({
          kind: "skill",
          source: "project",
          providers: ["cursor"],
        });
        expect(items.find((i) => i.name === "ship")).toMatchObject({
          kind: "command",
          source: "project",
          providers: ["cursor"],
        });
      } finally {
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("cursor plugin cache: scans newest hash dir by mtime, not lexical order", () => {
      const pluginRoot = NodePath.join(fakeHome, ".cursor", "plugins", "cache", "mp", "myplug");
      /** Lexically last — would win if we wrongly sorted by name instead of mtime. */
      const dirStaleLexLast = NodePath.join(pluginRoot, "zebra-hash");
      /** Lexically first — must win because its mtime is newest. */
      const dirFreshLexFirst = NodePath.join(pluginRoot, "apple-hash");
      NodeFS.mkdirSync(NodePath.join(dirStaleLexLast, "skills", "deploy"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(dirFreshLexFirst, "skills", "deploy"), { recursive: true });
      writeMd(NodePath.join(dirStaleLexLast, "skills", "deploy", "SKILL.md"), {
        description: "Stale plugin skill",
      });
      writeMd(NodePath.join(dirFreshLexFirst, "skills", "deploy", "SKILL.md"), {
        description: "Fresh plugin skill",
      });

      NodeFS.utimesSync(dirStaleLexLast, new Date("2020-06-01"), new Date("2020-06-01"));
      NodeFS.utimesSync(dirFreshLexFirst, new Date("2025-06-01"), new Date("2025-06-01"));

      const items = new SkillService().list(undefined, "cursor");
      const deploy = items.find((i) => i.name === "myplug:deploy");
      expect(deploy).toMatchObject({
        kind: "skill",
        source: "plugin",
        description: "Fresh plugin skill",
        providers: ["cursor"],
      });
    });

    it("cursor plugin cache: scans workflow-skills alongside skills/", () => {
      const wfDir = NodePath.join(
        fakeHome,
        ".cursor",
        "plugins",
        "local",
        "mp",
        "wfplug",
        "hash1",
        "workflow-skills",
        "analyze",
      );
      NodeFS.mkdirSync(wfDir, { recursive: true });
      writeMd(NodePath.join(wfDir, "SKILL.md"), { description: "Workflow skill" });

      const items = new SkillService().list(undefined, "cursor");
      expect(items.find((i) => i.name === "wfplug:analyze")).toMatchObject({
        kind: "skill",
        source: "plugin",
        providers: ["cursor"],
      });
    });

    it("cursor plugin skills under .cursor/skills are tagged for cursor provider", () => {
      const skillDir = NodePath.join(
        fakeHome,
        ".cursor",
        "plugins",
        "cache",
        "mp",
        "native",
        "v1",
        ".cursor",
        "skills",
        "native-skill",
      );
      NodeFS.mkdirSync(skillDir, { recursive: true });
      writeMd(NodePath.join(skillDir, "SKILL.md"), { description: "Native cursor plugin layout" });

      const items = new SkillService().list(undefined, "cursor");
      expect(items.find((i) => i.name === "native:native-skill")).toMatchObject({
        providers: ["cursor"],
      });
    });

    it("plugin .agents/skills/ is NOT exposed to non-Claude providers", () => {
      // Plugins live under ~/.claude/plugins/ — Claude's own infrastructure.
      // Even if a plugin ships .agents/ subdirs, those don't grant cross-provider access.
      // A user who installed impeccable as a Claude plugin should not see it in Codex/Copilot.
      const skillDir = NodePath.join(
        fakeHome, ".claude", "plugins", "cache", "mp", "impeccable", "2.1.1",
        ".agents", "skills", "impeccable",
      );
      NodeFS.mkdirSync(skillDir, { recursive: true });
      writeMd(NodePath.join(skillDir, "SKILL.md"), { description: "Cross-provider skill" });

      const svc = new SkillService();

      // Non-Claude providers must not see skills from Claude's plugin cache.
      const copilotItems = svc.list(undefined, "copilot");
      expect(copilotItems.find((i) => i.name === "impeccable:impeccable")).toBeUndefined();

      svc.invalidate();
      const codexItems = svc.list(undefined, "codex");
      expect(codexItems.find((i) => i.name === "impeccable:impeccable")).toBeUndefined();
    });

    it("plugin .codex/skills/ is NOT exposed to Codex", () => {
      // Same rule — .codex/ subdir in a Claude plugin does not make it available to Codex.
      const skillDir = NodePath.join(
        fakeHome, ".claude", "plugins", "cache", "mp", "myplugin", "1.0.0",
        ".codex", "skills", "codex-task",
      );
      NodeFS.mkdirSync(skillDir, { recursive: true });
      writeMd(NodePath.join(skillDir, "SKILL.md"), { description: "Codex subdir skill" });

      const svc = new SkillService();

      const codexItems = svc.list(undefined, "codex");
      expect(codexItems.find((i) => i.name === "myplugin:codex-task")).toBeUndefined();
    });

    it("marketplace plugin: .agents/skills/ is not exposed to non-Claude providers", () => {
      // Marketplace plugins are part of Claude's plugin infrastructure — same rule as
      // the cache. Skills under .agents/ don't grant cross-provider access. The skill
      // name uses the marketplace name as prefix (not ".agents:"), but it's Claude-only.
      const skillDir = NodePath.join(
        fakeHome, ".claude", "plugins", "marketplaces", "impeccable",
        ".agents", "skills", "impeccable",
      );
      NodeFS.mkdirSync(skillDir, { recursive: true });
      writeMd(NodePath.join(skillDir, "SKILL.md"), { description: "Marketplace skill" });

      const svc = new SkillService();

      // Non-Claude providers must not see it.
      const copilotItems = svc.list(undefined, "copilot");
      expect(copilotItems.find((i) => i.name === "impeccable:impeccable")).toBeUndefined();
      expect(copilotItems.find((i) => i.name === ".agents:impeccable")).toBeUndefined();

      svc.invalidate();
      const codexItems = svc.list(undefined, "codex");
      expect(codexItems.find((i) => i.name === "impeccable:impeccable")).toBeUndefined();
    });

    it("marketplace plugin: .claude/skills/ produces <marketplace-name>:* prefix for claude only", () => {
      const skillDir = NodePath.join(
        fakeHome, ".claude", "plugins", "marketplaces", "impeccable",
        ".claude", "skills", "audit",
      );
      NodeFS.mkdirSync(skillDir, { recursive: true });
      writeMd(NodePath.join(skillDir, "SKILL.md"), { description: "Claude-only marketplace skill" });

      const svc = new SkillService();

      const claudeItems = svc.list(undefined, "claude");
      expect(claudeItems.find((i) => i.name === "impeccable:audit")).toBeDefined();
      // No .claude:audit prefix — the marketplace dir IS the version root.
      expect(claudeItems.find((i) => i.name === ".claude:audit")).toBeUndefined();

      svc.invalidate();
      const codexItems = svc.list(undefined, "codex");
      expect(codexItems.find((i) => i.name === "impeccable:audit")).toBeUndefined();
    });

    it("marketplace plugin: cache and marketplace produce same skill names (dedup collapses them)", () => {
      // Cache and marketplace both produce "impeccable:adapt" — dedup should keep one.
      const cacheSkillDir = NodePath.join(
        fakeHome, ".claude", "plugins", "cache", "mp", "impeccable", "2.1.1",
        ".claude", "skills", "adapt",
      );
      const marketplaceSkillDir = NodePath.join(
        fakeHome, ".claude", "plugins", "marketplaces", "impeccable",
        ".claude", "skills", "adapt",
      );
      NodeFS.mkdirSync(cacheSkillDir, { recursive: true });
      NodeFS.mkdirSync(marketplaceSkillDir, { recursive: true });
      writeMd(NodePath.join(cacheSkillDir, "SKILL.md"), { description: "Cache version" });
      writeMd(NodePath.join(marketplaceSkillDir, "SKILL.md"), { description: "Marketplace version" });

      const items = new SkillService().list(undefined, "claude");
      const matches = items.filter((i) => i.name === "impeccable:adapt");
      expect(matches).toHaveLength(1);
    });
  });
});
