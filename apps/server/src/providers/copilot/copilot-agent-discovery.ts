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
    .flatMap((f) => {
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf-8");
        const parsed = parseYaml(raw) as AgentYaml;
        if (typeof parsed?.name !== "string" || !parsed.name.trim()) return [];
        if (parsed.displayName !== undefined && typeof parsed.displayName !== "string") return [];
        if (parsed.description !== undefined && typeof parsed.description !== "string") return [];
        return [
          {
            name: parsed.name,
            displayName: parsed.displayName ?? parsed.name,
            description: parsed.description ?? "",
            source,
          } satisfies CopilotSubagent,
        ];
      } catch {
        // Silently skip malformed YAML — don't crash discovery for one bad file.
        return [];
      }
    });
}

/**
 * Returns the user-level agents directory for the Copilot CLI on the current OS.
 * Windows: %APPDATA%\GitHub Copilot\agents
 * Linux/macOS: ~/.config/github-copilot/agents
 */
function userAgentsDir(): string {
  if (process.platform === "win32") {
    const appData =
      process.env["APPDATA"] ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "GitHub Copilot", "agents");
  }
  return path.join(os.homedir(), ".config", "github-copilot", "agents");
}

/**
 * Discovers all available Copilot sub-agents across three tiers:
 * - Default: hardcoded built-in session modes (always present)
 * - User: YAML files in the OS-level GitHub Copilot config dir
 * - Project: YAML files in `.github/agents/` or `.copilot/agents/` within `workingDirectory`
 *
 * Always returns at least the three built-in defaults.
 */
export function discoverCopilotAgents(workingDirectory: string, userDir?: string): CopilotSubagent[] {
  const user = scanAgentDir(userDir ?? userAgentsDir(), "user");
  const project = [
    ...scanAgentDir(path.join(workingDirectory, ".github", "agents"), "project"),
    ...scanAgentDir(path.join(workingDirectory, ".copilot", "agents"), "project"),
  ];
  return [...COPILOT_DEFAULT_AGENTS, ...user, ...project];
}
