import "reflect-metadata";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_CUSTOM_PROMPT_MAX_DIRECTORY_ENTRIES,
  CODEX_CUSTOM_PROMPT_MAX_FILE_BYTES,
  CODEX_CUSTOM_PROMPT_MAX_FILES,
  CodexCustomPromptService,
  discoverCodexCustomPrompts,
  resolveEffectiveCodexHome,
  type CodexCustomPromptFileSystem,
} from "../codex-custom-prompt-service.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcode-codex-prompts-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("CodexCustomPromptService", () => {
  it("discovers only direct Markdown prompts under the effective CODEX_HOME", async () => {
    const codexHome = await createTemporaryDirectory();
    const promptDirectory = join(codexHome, "prompts");
    await mkdir(join(promptDirectory, "nested"), { recursive: true });
    await writeFile(
      join(promptDirectory, "release.md"),
      "---\ndescription: Prepare a release\n---\nRelease $ARGUMENTS.",
    );
    await writeFile(join(promptDirectory, "ignored.txt"), "Ignored");
    await writeFile(join(promptDirectory, "nested", "project.md"), "Nested");

    const service = new CodexCustomPromptService({
      getEnv: () => ({ CODEX_HOME: codexHome, USERPROFILE: "C:\\wrong-home" }),
    } as never);

    const result = await service.refresh();

    expect(resolveEffectiveCodexHome({ CODEX_HOME: codexHome })).toBe(codexHome);
    expect(result.prompts).toEqual([{
      name: "prompts:release",
      nativeName: "release",
      description: "Prepare a release",
      kind: "command",
      source: "user",
      providers: ["codex"],
      path: join(promptDirectory, "release.md"),
    }]);
    expect(result.diagnostics).toEqual([]);
    expect(service.currentPrompts()).toEqual(result.prompts);
  });

  it("bounds direct prompt file count and reports the first excessive file", async () => {
    const codexHome = await createTemporaryDirectory();
    const promptDirectory = join(codexHome, "prompts");
    await mkdir(promptDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(promptDirectory, "one.md"), "One"),
      writeFile(join(promptDirectory, "two.md"), "Two"),
    ]);

    const result = await discoverCodexCustomPrompts(codexHome, {
      maxFiles: 1,
      maxFileBytes: CODEX_CUSTOM_PROMPT_MAX_FILE_BYTES,
    });

    expect(result.prompts).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "partial-result",
        message: expect.stringContaining("at most 1 direct .md file"),
      }),
    ]);
  });

  it("bounds directory traversal even when entries are not supported prompt files", async () => {
    let yieldedEntries = 0;
    const fileSystem: CodexCustomPromptFileSystem = {
      async *entries() {
        for (const name of ["valid.md", "ignored.txt", "later.md", "never.md"]) {
          yieldedEntries += 1;
          yield { name, isFile: true };
        }
      },
      async readFile(path) {
        return Buffer.from(path.endsWith("valid.md") ? "Valid" : "Later");
      },
    };

    const result = await discoverCodexCustomPrompts("C:\\codex-home", {
      maxDirectoryEntries: 2,
      maxFiles: CODEX_CUSTOM_PROMPT_MAX_FILES,
      maxFileBytes: CODEX_CUSTOM_PROMPT_MAX_FILE_BYTES,
      fileSystem,
    });

    expect(yieldedEntries).toBe(3);
    expect(result.prompts.map((prompt) => prompt.nativeName)).toEqual(["valid"]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "partial-result",
        message: expect.stringContaining("at most 2 direct directory entries"),
      }),
    ]);
    expect(CODEX_CUSTOM_PROMPT_MAX_DIRECTORY_ENTRIES).toBeGreaterThan(
      CODEX_CUSTOM_PROMPT_MAX_FILES,
    );
  });

  it("retains the partial-result diagnostic after every supported file fails", async () => {
    const fileSystem: CodexCustomPromptFileSystem = {
      async *entries() {
        for (let index = 0; index <= CODEX_CUSTOM_PROMPT_MAX_FILES; index += 1) {
          yield { name: `prompt-${index}.md`, isFile: true };
        }
      },
      async readFile() {
        throw new Error("access denied");
      },
    };

    const result = await discoverCodexCustomPrompts("C:\\codex-home", {
      maxFiles: CODEX_CUSTOM_PROMPT_MAX_FILES,
      maxFileBytes: CODEX_CUSTOM_PROMPT_MAX_FILE_BYTES,
      fileSystem,
    });

    expect(result.diagnostics).toHaveLength(CODEX_CUSTOM_PROMPT_MAX_FILES + 1);
    expect(result.diagnostics.at(-1)).toMatchObject({ code: "partial-result" });
  });

  it("rejects an oversized prompt while retaining a valid sibling", async () => {
    const codexHome = await createTemporaryDirectory();
    const promptDirectory = join(codexHome, "prompts");
    await mkdir(promptDirectory, { recursive: true });
    await writeFile(join(promptDirectory, "valid.md"), "Valid");
    await writeFile(join(promptDirectory, "oversized.md"), "x".repeat(9));

    const result = await discoverCodexCustomPrompts(codexHome, {
      maxFiles: CODEX_CUSTOM_PROMPT_MAX_FILES,
      maxFileBytes: 8,
    });

    expect(result.prompts.map((prompt) => prompt.nativeName)).toEqual(["valid"]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "discovery-error",
      message: expect.stringContaining("oversized.md"),
    }));
  });

  it("isolates malformed and unreadable prompts while retaining valid siblings", async () => {
    const codexHome = "C:\\codex-home";
    const fileSystem: CodexCustomPromptFileSystem = {
      async *entries() {
        yield { name: "valid.md", isFile: true };
        yield { name: "malformed.md", isFile: true };
        yield { name: "unreadable.md", isFile: true };
      },
      async readFile(path) {
        if (path.endsWith("unreadable.md")) throw new Error("access denied");
        if (path.endsWith("malformed.md")) return Buffer.from("---\ndescription: missing close");
        return Buffer.from("---\ndescription: Valid prompt\n---\nBody");
      },
    };

    const result = await discoverCodexCustomPrompts(codexHome, {
      maxFiles: CODEX_CUSTOM_PROMPT_MAX_FILES,
      maxFileBytes: CODEX_CUSTOM_PROMPT_MAX_FILE_BYTES,
      fileSystem,
    });

    expect(result.prompts.map((prompt) => prompt.nativeName)).toEqual(["valid"]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("malformed.md") }),
      expect.objectContaining({ message: expect.stringContaining("unreadable.md") }),
    ]));
  });

  it("rejects invalid UTF-8 without hiding valid prompts", async () => {
    const codexHome = await createTemporaryDirectory();
    const promptDirectory = join(codexHome, "prompts");
    await mkdir(promptDirectory, { recursive: true });
    await writeFile(join(promptDirectory, "valid.md"), "Valid");
    await writeFile(join(promptDirectory, "invalid.md"), Buffer.from([0xc3, 0x28]));

    const result = await discoverCodexCustomPrompts(codexHome);

    expect(result.prompts.map((prompt) => prompt.nativeName)).toEqual(["valid"]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "discovery-error",
      message: expect.stringContaining("invalid.md"),
    }));
  });

  it("refreshes changed prompt metadata and removes deleted prompts by stable name", async () => {
    const codexHome = await createTemporaryDirectory();
    const promptDirectory = join(codexHome, "prompts");
    const promptPath = join(promptDirectory, "release.md");
    await mkdir(promptDirectory, { recursive: true });
    await writeFile(promptPath, "---\ndescription: First release prompt\n---\nFirst body");
    const service = new CodexCustomPromptService({
      getEnv: () => ({ CODEX_HOME: codexHome }),
    } as never);

    const first = await service.refresh();
    await writeFile(promptPath, "---\ndescription: Updated release prompt\n---\nUpdated body");
    const updated = await service.refresh();
    await rm(promptPath);
    const removed = await service.refresh();

    expect(first.prompts[0]).toMatchObject({
      name: "prompts:release",
      nativeName: "release",
      description: "First release prompt",
    });
    expect(updated.prompts[0]).toMatchObject({
      name: "prompts:release",
      nativeName: "release",
      description: "Updated release prompt",
    });
    expect(removed.prompts).toEqual([]);
  });
});
