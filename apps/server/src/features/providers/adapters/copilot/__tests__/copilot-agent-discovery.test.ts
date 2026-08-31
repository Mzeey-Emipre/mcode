import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { discoverCopilotAgents as discoverCopilotAgentsForPlatform } from "../copilot-agent-discovery.js";

function discoverCopilotAgents(workingDirectory: string, userDir?: string) {
  return discoverCopilotAgentsForPlatform(workingDirectory, "linux", userDir);
}

describe("discoverCopilotAgents", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "copilot-agents-"));
  });

  afterEach(() => {
    NodeFS.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns only defaults when no YAML files exist", () => {
    const result = discoverCopilotAgents(tmpDir, NodePath.join(tmpDir, "no-user-agents"));
    expect(result).toHaveLength(3);
    expect(result.every((a) => a.source === "default")).toBe(true);
  });

  it("includes project-level agents from .github/agents/", () => {
    const agentsDir = NodePath.join(tmpDir, ".github", "agents");
    NodeFS.mkdirSync(agentsDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(agentsDir, "reviewer.yml"),
      "name: reviewer\ndisplayName: Code Reviewer\ndescription: Reviews code changes\n",
    );
    const result = discoverCopilotAgents(tmpDir, NodePath.join(tmpDir, "no-user-agents"));
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
    const agentsDir = NodePath.join(tmpDir, ".copilot", "agents");
    NodeFS.mkdirSync(agentsDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(agentsDir, "tester.yaml"),
      "name: tester\ndescription: Writes tests\n",
    );
    const result = discoverCopilotAgents(tmpDir, NodePath.join(tmpDir, "no-user-agents"));
    const custom = result.filter((a) => a.source === "project");
    expect(custom[0]).toMatchObject({ name: "tester", displayName: "tester", source: "project" });
  });

  it("skips YAML files missing a name field", () => {
    const agentsDir = NodePath.join(tmpDir, ".github", "agents");
    NodeFS.mkdirSync(agentsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(agentsDir, "bad.yml"), "displayName: Missing Name\n");
    const result = discoverCopilotAgents(tmpDir, NodePath.join(tmpDir, "no-user-agents"));
    expect(result.filter((a) => a.source === "project")).toHaveLength(0);
  });

  it("skips malformed YAML without crashing", () => {
    const agentsDir = NodePath.join(tmpDir, ".github", "agents");
    NodeFS.mkdirSync(agentsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(agentsDir, "broken.yml"), ": : invalid:\n");
    expect(() => discoverCopilotAgents(tmpDir, NodePath.join(tmpDir, "no-user-agents"))).not.toThrow();
    expect(discoverCopilotAgents(tmpDir, NodePath.join(tmpDir, "no-user-agents"))).toHaveLength(3);
  });

  it("returns defaults first, then user, then project agents", () => {
    const agentsDir = NodePath.join(tmpDir, ".github", "agents");
    NodeFS.mkdirSync(agentsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(agentsDir, "proj.yml"), "name: proj\n");
    const result = discoverCopilotAgents(tmpDir, NodePath.join(tmpDir, "no-user-agents"));
    expect(result[0]!.source).toBe("default");
    expect(result[result.length - 1]!.source).toBe("project");
  });

  it("includes user-level agents from the provided userDir", () => {
    const userDir = NodePath.join(tmpDir, "user-agents");
    NodeFS.mkdirSync(userDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(userDir, "assistant.yml"),
      "name: assistant\ndisplayName: Assistant\ndescription: My user agent\n",
    );
    const result = discoverCopilotAgents(tmpDir, userDir);
    const userAgents = result.filter((a) => a.source === "user");
    expect(userAgents).toHaveLength(1);
    expect(userAgents[0]).toMatchObject({
      name: "assistant",
      displayName: "Assistant",
      description: "My user agent",
      source: "user",
    });
  });
});
