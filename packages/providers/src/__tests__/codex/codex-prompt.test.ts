import { describe, expect, it, afterEach } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { SkillInfo } from "@mcode/contracts";
import {
  expandCodexPromptTemplate,
  resolveCodexPromptInvocation,
} from "../../private/codex/codex-prompt.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-prompt-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Codex custom prompt expansion", () => {
  it("expands positional, named, raw argument, and literal dollar placeholders", () => {
    const expanded = expandCodexPromptTemplate(
      "File: $FILE\nTitle: $PR_TITLE\nFirst: $1\nAll: $ARGUMENTS\nCost: $$5",
      'FILES="ignored" alpha FILE=src/index.ts PR_TITLE="Add hero"',
    );

    expect(expanded).toBe(
      'File: src/index.ts\nTitle: Add hero\nFirst: alpha\nAll: FILES="ignored" alpha FILE=src/index.ts PR_TITLE="Add hero"\nCost: $5',
    );
  });

  it("expands a discovered /prompts:name invocation from the prompt file body", async () => {
    const dir = tempDir();
    const promptPath = NodePath.join(dir, "draftpr.md");
    NodeFS.writeFileSync(
      promptPath,
      "---\ndescription: Draft a PR\n---\nCreate PR for $FILES with title $PR_TITLE.",
    );
    const catalog: SkillInfo[] = [{
      name: "prompts:draftpr",
      nativeName: "draftpr",
      description: "Draft a PR",
      kind: "command",
      source: "user",
      providers: ["codex"],
      path: promptPath,
    }];

    await expect(
      resolveCodexPromptInvocation(
        '/prompts:draftpr FILES="src/a.ts src/b.ts" PR_TITLE="Add files"',
        catalog,
      ),
    ).resolves.toBe("Create PR for src/a.ts src/b.ts with title Add files.");
  });

  it("does not expand a prompt command by its native basename", async () => {
    const dir = tempDir();
    const promptPath = NodePath.join(dir, "draftpr.md");
    NodeFS.writeFileSync(promptPath, "Create PR for $ARGUMENTS.");
    const catalog: SkillInfo[] = [{
      name: "prompts:draftpr",
      nativeName: "draftpr",
      description: "Draft a PR",
      kind: "command",
      source: "user",
      providers: ["codex"],
      path: promptPath,
    }];

    await expect(resolveCodexPromptInvocation("/draftpr src/a.ts", catalog)).resolves.toBeNull();
  });
});
