import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import type { CopilotSubagent } from "@mcode/contracts";

/**
 * Built-in Copilot session modes, always shown regardless of user config.
 * These map to `session.rpc.mode.set()` mode values.
 */
export const COPILOT_DEFAULT_AGENTS: CopilotSubagent[] = [
  {
    name: "interactive",
    displayName: "Ask",
    description: "Interactive Q&A — answers questions without running tools autonomously.",
    source: "default",
  },
  {
    name: "plan",
    displayName: "Plan",
    description: "Proposes a step-by-step plan and waits for approval before executing.",
    source: "default",
  },
  {
    name: "autopilot",
    displayName: "Agent",
    description: "Fully autonomous — runs tools and makes changes without step-by-step approval.",
    source: "default",
  },
];

/** Minimal shape we expect from a parsed agent YAML file. */
interface AgentYaml {
  name?: string;
  displayName?: string;
  description?: string;
}

function validAgentName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidOptionalString(value: unknown): boolean {
  return value !== undefined && typeof value !== "string";
}

/** Parses one agent YAML file into a validated Copilot sub-agent. */
function readAgentFile(filePath: string, source: "user" | "project"): CopilotSubagent | null {
  try {
    const parsed = parseYaml(fs.readFileSync(filePath, "utf-8")) as AgentYaml;
    if (!validAgentName(parsed?.name)) return null;
    if (invalidOptionalString(parsed.displayName)) return null;
    if (invalidOptionalString(parsed.description)) return null;
    return {
      name: parsed.name,
      displayName: parsed.displayName ?? parsed.name,
      description: parsed.description ?? "",
      source,
    };
  } catch {
    // Silently skip malformed YAML so one bad file cannot stop discovery.
    return null;
  }
}

/** Scans a directory for `*.yml`/`*.yaml` files and parses each as a CopilotSubagent. */
function scanAgentDir(dir: string, source: "user" | "project"): CopilotSubagent[] {
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .flatMap((fileName) => {
      const agent = readAgentFile(path.join(dir, fileName), source);
      return agent ? [agent] : [];
    });
}

/**
 * Returns the user-level agents directory for the Copilot CLI on the current OS.
 * Windows: %APPDATA%\GitHub Copilot\agents
 * Linux/macOS: ~/.config/github-copilot/agents
 */
function userAgentsDir(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const appData =
      process.env["APPDATA"] ?? NodePath.join(NodeOS.homedir(), "AppData", "Roaming");
    return NodePath.join(appData, "GitHub Copilot", "agents");
  }
  return NodePath.join(NodeOS.homedir(), ".config", "github-copilot", "agents");
}

/**
 * Discovers all available Copilot sub-agents across three tiers:
 * - Default: hardcoded built-in session modes (always present)
 * - User: YAML files in the OS-level GitHub Copilot config dir
 * - Project: YAML files in `.github/agents/` or `.copilot/agents/` within `workingDirectory`
 *
 * Always returns at least the three built-in defaults.
 */
export function discoverCopilotAgents(
  workingDirectory: string,
  platform: NodeJS.Platform,
  userDir?: string,
): CopilotSubagent[] {
  const user = scanAgentDir(userDir ?? userAgentsDir(platform), "user");
  const project = [
    ...scanAgentDir(NodePath.join(workingDirectory, ".github", "agents"), "project"),
    ...scanAgentDir(NodePath.join(workingDirectory, ".copilot", "agents"), "project"),
  ];
  return [...COPILOT_DEFAULT_AGENTS, ...user, ...project];
}
