/**
 * Claude Code configuration discovery.
 * Ported from crates/mcode-core/src/config/claude.rs
 *
 * Read-only: never modifies any files.
 */

import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import which from "which";

export interface ConfigSummary {
  has_user_config: boolean;
  has_project_config: boolean;
  has_user_claude_md: boolean;
  has_project_claude_md: boolean;
  cli_path: string;
  cli_available: boolean;
}

/**
 * Discover Claude Code configuration from the environment.
 * Checks user-level (~/.claude/) and project-level (.claude/) config.
 */
export function discoverConfig(workspacePath: string): ConfigSummary {
  const home = homedir();
  const userConfigDir = join(home, ".claude");
  const projectConfigDir = join(workspacePath, ".claude");

  const cliPath = process.env.MCODE_CLAUDE_PATH || "claude";

  let cliAvailable = false;
  try {
    which.sync(cliPath);
    cliAvailable = true;
  } catch {
    // CLI not found on PATH
  }

  // Project CLAUDE.md can be at workspace root or inside .claude/
  const hasProjectClaudeMd =
    existsSync(join(workspacePath, "CLAUDE.md")) ||
    existsSync(join(projectConfigDir, "CLAUDE.md"));

  return {
    has_user_config: existsSync(userConfigDir),
    has_project_config: existsSync(projectConfigDir),
    has_user_claude_md: existsSync(join(home, ".claude", "CLAUDE.md")),
    has_project_claude_md: hasProjectClaudeMd,
    cli_path: cliPath,
    cli_available: cliAvailable,
  };
}

/**
 * Build environment variables for spawning a Claude CLI process.
 * Ensures HOME is set so ~/.claude/ is discovered.
 */
export function spawnEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const home = homedir();
  if (home) {
    env.HOME = home;
  }
  return env;
}
