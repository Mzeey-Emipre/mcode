/**
 * Claude configuration discovery service.
 * Checks for user-level and project-level Claude Code config files.
 * Extracted from apps/desktop/src/main/config.ts.
 */

import { injectable } from "tsyringe";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import which from "which";

/** Summary of discovered Claude Code configuration. */
export interface ConfigSummary {
  has_user_config: boolean;
  has_project_config: boolean;
  has_user_claude_md: boolean;
  has_project_claude_md: boolean;
  cli_path: string;
  cli_available: boolean;
}

/** Discovers Claude Code configuration from user and project directories. */
@injectable()
export class ConfigService {
  /** Discover Claude Code configuration for a given workspace path. */
  discover(workspacePath: string): ConfigSummary {
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
}
