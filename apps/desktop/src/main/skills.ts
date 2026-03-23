import { readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * List available Claude SDK skills by scanning subdirectory names under
 * ~/.claude/skills/. Returns [] if the directory does not exist.
 */
export function listSkills(): string[] {
  const skillsDir = join(homedir(), ".claude", "skills");
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
