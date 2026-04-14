import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverCopilotAgents } from "./copilot-agent-discovery.js";

describe("discoverCopilotAgents", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agents-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns only defaults when no YAML files exist", () => {
    const result = discoverCopilotAgents(tmpDir);
    expect(result).toHaveLength(3);
    expect(result.every((a) => a.source === "default")).toBe(true);
  });

  it("includes project-level agents from .github/agents/", () => {
    const agentsDir = path.join(tmpDir, ".github", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "reviewer.yml"),
      "name: reviewer\ndisplayName: Code Reviewer\ndescription: Reviews code changes\n",
    );
    const result = discoverCopilotAgents(tmpDir);
    const custom = result.filter((a) => a.source === "project");
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({
      name: "reviewer",
      displayName: "Code Reviewer",
      description: "Reviews code changes",
      source: "project",
    });
  });

  it("includes project-level agents from .copilot/agents/", () => {
    const agentsDir = path.join(tmpDir, ".copilot", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "tester.yaml"),
      "name: tester\ndescription: Writes tests\n",
    );
    const result = discoverCopilotAgents(tmpDir);
    const custom = result.filter((a) => a.source === "project");
    expect(custom[0]).toMatchObject({ name: "tester", displayName: "tester", source: "project" });
  });

  it("skips YAML files missing a name field", () => {
    const agentsDir = path.join(tmpDir, ".github", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "bad.yml"), "displayName: Missing Name\n");
    const result = discoverCopilotAgents(tmpDir);
    expect(result.filter((a) => a.source === "project")).toHaveLength(0);
  });

  it("skips malformed YAML without crashing", () => {
    const agentsDir = path.join(tmpDir, ".github", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "broken.yml"), ": : invalid:\n");
    expect(() => discoverCopilotAgents(tmpDir)).not.toThrow();
    expect(discoverCopilotAgents(tmpDir)).toHaveLength(3);
  });

  it("returns defaults first, then user, then project agents", () => {
    const agentsDir = path.join(tmpDir, ".github", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "proj.yml"), "name: proj\n");
    const result = discoverCopilotAgents(tmpDir);
    expect(result[0]!.source).toBe("default");
    expect(result[result.length - 1]!.source).toBe("project");
  });
});
