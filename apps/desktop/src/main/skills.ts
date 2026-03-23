import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface SkillInfo {
  name: string;
  description: string;
}

/**
 * Read the description from a skill's SKILL.md frontmatter.
 * Returns "" if the file is missing or has no description field.
 */
function readSkillDescription(skillPath: string): string {
  try {
    const content = readFileSync(join(skillPath, "SKILL.md"), "utf-8");
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) return "";
    const frontmatter = frontmatterMatch[1];
    const descMatch = frontmatter.match(
      /^description:\s*(?:"([^"]*)"|'([^']*)'|(.*))$/m,
    );
    if (!descMatch) return "";
    return (descMatch[1] ?? descMatch[2] ?? descMatch[3] ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * List available Claude SDK skills by scanning subdirectory names under
 * ~/.claude/skills/ and reading each skill's description from SKILL.md.
 * Returns [] if the directory does not exist.
 */
export function listSkills(): SkillInfo[] {
  const skillsDir = join(homedir(), ".claude", "skills");
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: e.name,
        description: readSkillDescription(join(skillsDir, e.name)),
      }));
  } catch {
    return [];
  }
}
