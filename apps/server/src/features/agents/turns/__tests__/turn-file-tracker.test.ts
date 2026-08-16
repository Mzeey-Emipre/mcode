import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEventType, type TurnFileEffectSummary } from "@mcode/contracts";
import { TurnFileTracker } from "../turn-file-tracker.js";
import {
  createCursorAcpTurnState,
  mapCursorAcpSessionNotification,
} from "../../../providers/adapters/cursor/cursor-acp-event-mapper.js";

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function trackerWithBaseline(
  baseline: Record<string, string | null>,
  updates: TurnFileEffectSummary[],
): TurnFileTracker {
  return new TurnFileTracker(
    async (_cwd, _ref, path) => {
      const value = baseline[path.replaceAll("\\", "/")];
      return value == null ? { kind: "missing" } : { kind: "text", text: value };
    },
    (_threadId, _turnId, summary) => updates.push(summary),
  );
}

describe("TurnFileTracker", () => {
  it("captures an unavailable-Git baseline before an early child mutation is attributed", async () => {
    const root = await tempDir("mcode-early-child-effects-");
    const trackedPath = join(root, "tracked.txt");
    await writeFile(trackedPath, "before\n");
    const updates: TurnFileEffectSummary[] = [];
    const tracker = new TurnFileTracker(
      async () => ({ kind: "unavailable" }),
      (_threadId, _turnId, summary) => updates.push(summary),
    );
    tracker.beginTurn("t", root, "unavailable-ref");
    const pendingStarts = [tracker.observeToolUse(
      "t",
      "file-child",
      "file_change",
      { changes: [{ path: "tracked.txt", kind: "edit" }] },
    )];
    await writeFile(trackedPath, "after\nextra\n");
    expect(pendingStarts).toHaveLength(1);
    await tracker.observeToolResult("t", "file-child");
    await Promise.all(pendingStarts);

    const summary = await tracker.finalizeTurn("t");
    expect(summary).toMatchObject({ fileCount: 1, additions: 2, deletions: 1 });
    expect(summary.effects[0]).toMatchObject({
      path: "tracked.txt",
      kind: "edited",
      toolCallIds: ["file-child"],
    });
    expect(updates.at(-1)).toEqual(summary);
  });

  it("classifies added, edited, and removed files with net line totals", async () => {
    const root = await tempDir("mcode-file-effects-");
    await writeFile(join(root, "edited.txt"), "one\ntwo");
    await writeFile(join(root, "removed.txt"), "old");
    const updates: TurnFileEffectSummary[] = [];
    const tracker = trackerWithBaseline({
      "edited.txt": "one\ntwo",
      "removed.txt": "old",
      "added.txt": null,
    }, updates);
    await tracker.beginTurn("t", root, "before");

    await tracker.observeToolUse("t", "edit", "Edit", { file_path: "edited.txt" });
    await writeFile(join(root, "edited.txt"), "one\nthree");
    await tracker.observeToolResult("t", "edit");
    await tracker.observeToolUse("t", "add", "Write", { file_path: "added.txt", content: "a\nb" });
    await writeFile(join(root, "added.txt"), "a\nb");
    await tracker.observeToolResult("t", "add");
    await tracker.observeToolUse("t", "remove", "Delete", { file_path: "removed.txt" });
    await rm(join(root, "removed.txt"));
    await tracker.observeToolResult("t", "remove", undefined);

    const summary = await tracker.finalizeTurn("t");
    expect(summary.effects.map((effect) => [effect.path, effect.kind])).toEqual([
      ["added.txt", "added"],
      ["edited.txt", "edited"],
      ["removed.txt", "removed"],
    ]);
    expect(summary).toMatchObject({ fileCount: 3, additions: 3, deletions: 2 });
    expect(updates.map((update) => update.revision)).toEqual([1, 2, 3]);
  });

  it("reports an observation failure while keeping finalization recoverable", async () => {
    const root = await tempDir("mcode-file-effects-observation-error-");
    await writeFile(join(root, "edited.txt"), "before\n");
    const tracker = new TurnFileTracker(
      async () => ({ kind: "text", text: "before\n" }),
      () => {
        throw new Error("update failed");
      },
    );
    await tracker.beginTurn("t", root, "before");
    await tracker.observeToolUse("t", "edit", "Edit", { file_path: "edited.txt" });
    await writeFile(join(root, "edited.txt"), "after\n");

    await expect(tracker.observeToolResult("t", "edit")).rejects.toThrow("update failed");
    await expect(tracker.finalizeTurn("t")).resolves.toMatchObject({ fileCount: 1 });
  });

  it("counts repeated edits once and removes a reverted effect", async () => {
    const root = await tempDir("mcode-file-effects-");
    await writeFile(join(root, "same.txt"), "base");
    const updates: TurnFileEffectSummary[] = [];
    const tracker = trackerWithBaseline({ "same.txt": "base" }, updates);
    await tracker.beginTurn("t", root, "before");

    await tracker.observeToolUse("t", "a", "Edit", { file_path: "same.txt" });
    await writeFile(join(root, "same.txt"), "first");
    await tracker.observeToolResult("t", "a");
    await tracker.observeToolUse("t", "b", "Edit", { file_path: "same.txt" });
    await writeFile(join(root, "same.txt"), "second");
    await tracker.observeToolResult("t", "b");
    expect((await tracker.finalizeTurn("t")).fileCount).toBe(1);

    await tracker.observeToolUse("t", "c", "Edit", { file_path: "same.txt" });
    await writeFile(join(root, "same.txt"), "base");
    await tracker.observeToolResult("t", "c");
    expect(await tracker.finalizeTurn("t")).toMatchObject({ fileCount: 0, additions: 0, deletions: 0 });
  });

  it("coalesces parallel sub-agent tools by path while retaining their provenance", async () => {
    const root = await tempDir("mcode-file-effects-subagents-");
    await writeFile(join(root, "shared.txt"), "base\n");
    const tracker = trackerWithBaseline({ "shared.txt": "base\n" }, []);
    tracker.beginTurn("parent-turn", root, "before");

    await Promise.all([
      tracker.observeToolUse("parent-turn", "subagent-a-edit", "Edit", { file_path: "shared.txt" }),
      tracker.observeToolUse("parent-turn", "subagent-b-edit", "Edit", { file_path: "shared.txt" }),
    ]);
    await writeFile(join(root, "shared.txt"), "changed\n");
    await Promise.all([
      tracker.observeToolResult("parent-turn", "subagent-a-edit"),
      tracker.observeToolResult("parent-turn", "subagent-b-edit"),
    ]);

    const summary = await tracker.finalizeTurn("parent-turn");
    expect(summary.fileCount).toBe(1);
    expect(summary.effects[0]).toMatchObject({
      path: "shared.txt",
      toolCallIds: ["subagent-a-edit", "subagent-b-edit"],
    });
  });

  it("detects a partial write even when the tool result is an error", async () => {
    const root = await tempDir("mcode-file-effects-");
    await writeFile(join(root, "partial.txt"), "before");
    const tracker = trackerWithBaseline({ "partial.txt": "before" }, []);
    await tracker.beginTurn("t", root, "before");
    await tracker.observeToolUse("t", "failed", "Write", { file_path: "partial.txt" });
    await writeFile(join(root, "partial.txt"), "part");
    await tracker.observeToolResult("t", "failed");
    expect((await tracker.finalizeTurn("t")).effects[0]).toMatchObject({ kind: "edited" });
  });

  it("marks external and symlink-escaped paths without persisting content", async () => {
    const root = await tempDir("mcode-file-effects-root-");
    const external = await tempDir("mcode-file-effects-external-");
    await writeFile(join(external, "outside.txt"), "old");
    await symlink(join(external, "outside.txt"), join(root, "link.txt"));
    const tracker = trackerWithBaseline({}, []);
    await tracker.beginTurn("t", root, "before");
    await tracker.observeToolUse("t", "external", "Edit", {
      file_path: join(root, "link.txt"),
      old_string: "old",
      new_string: "new",
    });
    await writeFile(join(external, "outside.txt"), "new");
    await tracker.observeToolResult("t", "external");
    const effect = (await tracker.finalizeTurn("t")).effects[0]!;
    expect(effect).toMatchObject({ scope: "external", kind: "edited" });
    expect(JSON.stringify(effect)).not.toContain("old");
    expect(JSON.stringify(effect)).not.toContain("new");
  });

  it("fails closed for malformed paths, ignores shell tools, and bounds candidates", async () => {
    const root = await tempDir("mcode-file-effects-");
    const tracker = trackerWithBaseline({}, []);
    await tracker.beginTurn("t", root, "before");
    await tracker.observeToolUse("t", "shell", "Bash", { command: "git pull origin main" });
    await tracker.observeToolUse("t", "bad", "Write", { file_path: "bad\0path" });
    await tracker.observeToolResult("t", "shell");
    await tracker.observeToolResult("t", "bad");
    expect((await tracker.finalizeTurn("t")).fileCount).toBe(0);
  });

  it("uses the tool-start state instead of unrelated earlier workspace changes", async () => {
    const root = await tempDir("mcode-file-effects-tool-baseline-");
    await writeFile(join(root, "same.txt"), "pulled-a\npulled-b\npulled-c\n");
    const tracker = trackerWithBaseline({ "same.txt": "old-a\nold-b\n" }, []);
    await tracker.beginTurn("t", root, "before-pull");

    await tracker.observeToolUse("t", "edit", "Edit", { file_path: "same.txt" });
    await writeFile(join(root, "same.txt"), "pulled-a\nagent-b\npulled-c\n");
    await tracker.observeToolResult("t", "edit");

    expect((await tracker.finalizeTurn("t")).effects[0]).toMatchObject({
      kind: "edited",
      additions: 1,
      deletions: 1,
    });
  });

  it("tracks explicit edits when no Git baseline is available", async () => {
    const root = await tempDir("mcode-file-effects-no-git-");
    await writeFile(join(root, "plain.txt"), "before\n");
    const tracker = trackerWithBaseline({}, []);
    await tracker.beginTurn("t", root, null);
    await tracker.observeToolUse("t", "edit", "Edit", { file_path: "plain.txt" });
    await writeFile(join(root, "plain.txt"), "after\n");
    await tracker.observeToolResult("t", "edit");

    expect((await tracker.finalizeTurn("t")).effects[0]).toMatchObject({
      path: "plain.txt",
      kind: "edited",
      scope: "workspace",
    });
  });

  it("does not treat Edit replacement snippets as full-file evidence", async () => {
    const root = await tempDir("mcode-file-effects-snippet-");
    await writeFile(join(root, "plain.txt"), "prefix\nneedle\nsuffix\n");
    const tracker = trackerWithBaseline({}, []);
    await tracker.beginTurn("t", root, null);

    await tracker.observeToolUse("t", "edit", "Edit", {
      file_path: "plain.txt",
      old_string: "needle",
      new_string: "replacement",
    });
    await tracker.observeToolResult("t", "edit");

    expect((await tracker.finalizeTurn("t")).fileCount).toBe(0);
  });

  it("records completion-only external changes without inventing line totals", async () => {
    const root = await tempDir("mcode-file-effects-completed-root-");
    const external = await tempDir("mcode-file-effects-completed-external-");
    const externalPath = join(external, "late.txt");
    await writeFile(externalPath, "after\n");
    const tracker = trackerWithBaseline({}, []);
    await tracker.beginTurn("t", root, null);

    await tracker.observeToolUse("t", "codex-file-change", "file_change", {
      changes: [{ path: externalPath, kind: "edit" }],
    });
    await tracker.observeToolResult("t", "codex-file-change");

    expect((await tracker.finalizeTurn("t")).effects[0]).toMatchObject({
      path: externalPath,
      kind: "edited",
      scope: "external",
      additions: null,
      deletions: null,
    });
  });

  it("keeps a provider-confirmed completion when a late Git ref already contains it", async () => {
    const root = await tempDir("mcode-file-effects-late-ref-");
    await writeFile(join(root, "late.txt"), "after\n");
    const tracker = trackerWithBaseline({ "late.txt": "after\n" }, []);
    const generation = tracker.beginTurn("t", root, null);

    await tracker.observeToolUse("t", "codex-file-change", "file_change", {
      changes: [{ path: "late.txt", kind: "edit" }],
    });
    await tracker.observeToolResult("t", "codex-file-change");
    await tracker.setBaselineRef("t", generation, "captured-after-edit");

    expect((await tracker.finalizeTurn("t")).effects[0]).toMatchObject({
      path: "late.txt",
      kind: "edited",
      scope: "workspace",
      additions: null,
      deletions: null,
    });
  });

  it("deduplicates bulk full-file evidence without synchronous file reads", async () => {
    const root = await tempDir("mcode-file-effects-bulk-evidence-");
    await writeFile(join(root, "bulk.txt"), "after\n");
    const tracker = trackerWithBaseline({}, []);
    tracker.beginTurn("t", root, null);
    const fullBeforeText = "x".repeat(1_048_576);
    const mutations = Array.from({ length: 256 }, () => ({
      path: "bulk.txt",
      kind: "edit",
      fullFileContent: true,
      beforeText: fullBeforeText,
      afterText: "after\n",
    }));

    const startedAt = performance.now();
    const observation = tracker.observeToolUse("t", "cursor-bulk", "edit", {
      _mcodeFileMutations: mutations,
    });
    const synchronousDurationMs = performance.now() - startedAt;
    await observation;
    await tracker.observeToolResult("t", "cursor-bulk");

    expect(synchronousDurationMs).toBeLessThan(250);
    expect((await tracker.finalizeTurn("t")).effects).toHaveLength(1);
  });

  it("bounds synchronous path observation across bulk rename pairs", async () => {
    const root = await tempDir("mcode-file-effects-bulk-renames-");
    const tracker = trackerWithBaseline({}, []);
    tracker.beginTurn("t", root, null);
    const mutations = Array.from({ length: 256 }, (_, index) => ({
      path: `renamed-${index}.txt`,
      oldPath: `original-${index}.txt`,
      kind: "rename",
    }));

    const startedAt = performance.now();
    const observation = tracker.observeToolUse("t", "bulk-renames", "rename", {
      _mcodeFileMutations: mutations,
    });
    const synchronousDurationMs = performance.now() - startedAt;
    await observation;

    expect(synchronousDurationMs).toBeLessThan(250);
  });

  it("falls back to complete async observation when a rename exceeds the remaining path budget", async () => {
    const root = await tempDir("mcode-file-effects-mixed-budget-");
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(root, `edit-${index}.txt`), "before\n");
    }
    await writeFile(join(root, "source.txt"), "rename me\n");
    const tracker = trackerWithBaseline({}, []);
    tracker.beginTurn("t", root, null);
    const mutations = [
      ...Array.from({ length: 3 }, (_, index) => ({
        path: `edit-${index}.txt`,
        kind: "edit",
      })),
      { path: "destination.txt", oldPath: "source.txt", kind: "rename" },
    ];

    await tracker.observeToolUse("t", "mixed", "edit", { _mcodeFileMutations: mutations });
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(root, `edit-${index}.txt`), "after\n");
    }
    await rename(join(root, "source.txt"), join(root, "destination.txt"));
    await tracker.observeToolResult("t", "mixed");

    expect((await tracker.finalizeTurn("t")).effects).toContainEqual(expect.objectContaining({
      path: "destination.txt",
      oldPath: "source.txt",
      kind: "renamed",
    }));
  });

  it("records provider-confirmed external additions that exceed the read limit", async () => {
    const root = await tempDir("mcode-file-effects-large-root-");
    const external = await tempDir("mcode-file-effects-large-external-");
    const externalPath = join(external, "large.txt");
    await writeFile(externalPath, "x".repeat(1_048_577));
    const tracker = trackerWithBaseline({}, []);
    await tracker.beginTurn("t", root, null);

    await tracker.observeToolUse("t", "codex-large-file", "file_change", {
      changes: [{ path: externalPath, kind: "add" }],
    });
    await tracker.observeToolResult("t", "codex-large-file");

    expect((await tracker.finalizeTurn("t")).effects[0]).toMatchObject({
      path: externalPath,
      kind: "added",
      scope: "external",
      additions: null,
      deletions: null,
      binary: true,
    });
  });

  it("does not turn an unchanged oversized file into an edit", async () => {
    const root = await tempDir("mcode-file-effects-oversized-");
    await writeFile(join(root, "large.txt"), "x".repeat(1_048_577));
    const tracker = trackerWithBaseline({ "large.txt": "ignored" }, []);
    await tracker.beginTurn("t", root, "before");
    await tracker.observeToolUse("t", "large", "Edit", { file_path: "large.txt" });
    await tracker.observeToolResult("t", "large");

    expect((await tracker.finalizeTurn("t")).fileCount).toBe(0);
  });

  it("tracks an added file whose nested parent directories did not exist at ToolUse", async () => {
    const root = await tempDir("mcode-file-effects-");
    const tracker = trackerWithBaseline({ "new/nested/file.txt": null }, []);
    await tracker.beginTurn("t", root, "before");
    await tracker.observeToolUse("t", "add-nested", "Write", {
      file_path: "new/nested/file.txt",
      content: "created",
    });
    await mkdir(join(root, "new", "nested"), { recursive: true });
    await writeFile(join(root, "new", "nested", "file.txt"), "created");
    await tracker.observeToolResult("t", "add-nested");
    expect((await tracker.finalizeTurn("t")).effects[0]).toMatchObject({
      path: join("new", "nested", "file.txt"),
      kind: "added",
      scope: "workspace",
    });
  });

  it("stress handles 120 concurrent completions, repeated paths, and reversions", async () => {
    const root = await tempDir("mcode-file-effects-stress-");
    const updates: TurnFileEffectSummary[] = [];
    const baseline: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) {
      baseline[`file-${i}.txt`] = "base";
      await writeFile(join(root, `file-${i}.txt`), "base");
    }
    const tracker = trackerWithBaseline(baseline, updates);
    await tracker.beginTurn("stress", root, "before");
    const startedAt = performance.now();
    const startedCpu = process.cpuUsage();
    await Promise.all(Array.from({ length: 120 }, async (_, i) => {
      const index = i % 20;
      const id = `call-${i}`;
      const path = `file-${index}.txt`;
      await tracker.observeToolUse("stress", id, "Edit", { file_path: path });
      await writeFile(join(root, path), i >= 100 ? `final-${index}` : `value-${i}`);
      await tracker.observeToolResult("stress", id);
    }));
    await Promise.all(Array.from({ length: 5 }, async (_, index) => {
      const id = `revert-${index}`;
      const path = `file-${index}.txt`;
      await tracker.observeToolUse("stress", id, "Edit", { file_path: path });
      await writeFile(join(root, path), "base");
      await tracker.observeToolResult("stress", id);
    }));
    const summary = await tracker.finalizeTurn("stress");
    const durationMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(startedCpu);
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    expect(summary.fileCount).toBe(15);
    expect(summary.effects).toHaveLength(15);
    expect(summary.revision).toBeGreaterThan(0);
    expect(updates.every((update, index) => index === 0 || update.revision > updates[index - 1]!.revision)).toBe(true);
    expect(cpuMs).toBeLessThan(2_500);
    console.info(`turn-file-tracker stress: 125 completions in ${durationMs.toFixed(1)}ms wall / ${cpuMs.toFixed(1)}ms CPU, revision ${summary.revision}`);
  }, 15_000);

  it("keeps an older finalizing generation isolated from a newly-started turn", async () => {
    const root = await tempDir("mcode-file-effects-generation-");
    await writeFile(join(root, "one.txt"), "base");
    const tracker = trackerWithBaseline({ "one.txt": "base" }, []);
    const first = await tracker.beginTurn("t", root, "first");
    await tracker.observeToolUse("t", "first-edit", "Edit", { file_path: "one.txt" });
    await writeFile(join(root, "one.txt"), "first");
    await tracker.observeToolResult("t", "first-edit");

    const second = await tracker.beginTurn("t", root, "second");
    await tracker.observeToolUse("t", "second-edit", "Edit", { file_path: "one.txt" });
    await writeFile(join(root, "one.txt"), "second");
    await tracker.observeToolResult("t", "second-edit");

    expect((await tracker.finalizeTurn("t", first)).effects[0]?.toolCallIds).toEqual(["first-edit"]);
    tracker.clearTurn("t", first);
    expect((await tracker.finalizeTurn("t", second)).effects[0]?.toolCallIds).toEqual(["second-edit"]);
  });

  it("routes a late result to the generation that received ToolUse after retry rollover", async () => {
    const root = await tempDir("mcode-file-effects-late-result-");
    await writeFile(join(root, "late.txt"), "base");
    const tracker = trackerWithBaseline({ "late.txt": "base" }, []);
    const first = await tracker.beginTurn("t", root, "first");
    await tracker.observeToolUse("t", "late-call", "Edit", { file_path: "late.txt" });
    const second = await tracker.beginTurn("t", root, "second");
    await writeFile(join(root, "late.txt"), "changed");
    await tracker.observeToolResult("t", "late-call");

    expect((await tracker.finalizeTurn("t", first)).effects[0]).toMatchObject({
      path: "late.txt",
      kind: "edited",
      toolCallIds: ["late-call"],
    });
    expect((await tracker.finalizeTurn("t", second)).fileCount).toBe(0);
  });

  it("tracks every completion-time Cursor ACP diff on an existing tool call", async () => {
    const root = await tempDir("mcode-file-effects-cursor-");
    await writeFile(join(root, "one.txt"), "one\n");
    await writeFile(join(root, "two.txt"), "two\n");
    const tracker = trackerWithBaseline({ "one.txt": "one\n", "two.txt": "two\n" }, []);
    await tracker.beginTurn("cursor-thread", root, "before");
    const state = createCursorAcpTurnState();
    const start = mapCursorAcpSessionNotification({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "cursor-edit",
        title: "Edit File",
        kind: "edit",
        status: "in_progress",
        rawInput: { file_path: "one.txt" },
      },
    } as never, "cursor-thread", state);
    for (const event of start) {
      if (event.type === AgentEventType.ToolUse) {
        await tracker.observeToolUse(event.threadId, event.toolCallId, event.toolName, event.toolInput);
      }
    }

    await writeFile(join(root, "one.txt"), "one changed\n");
    await writeFile(join(root, "two.txt"), "two changed\n");
    const completed = mapCursorAcpSessionNotification({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "cursor-edit",
        title: "Edit File",
        kind: "edit",
        status: "completed",
        content: [
          { type: "diff", path: "one.txt", oldText: "one\n", newText: "one changed\n" },
          { type: "diff", path: "two.txt", oldText: "two\n", newText: "two changed\n" },
        ],
      },
    } as never, "cursor-thread", state);
    for (const event of completed) {
      if (event.type === AgentEventType.ToolResult) {
        await tracker.observeToolResult(event.threadId, event.toolCallId, event.toolInput);
      }
    }

    expect((await tracker.finalizeTurn("cursor-thread")).effects.map((effect) => effect.path)).toEqual([
      "one.txt",
      "two.txt",
    ]);
  });

  it("emits one validated explicit rename with a normalized old path", async () => {
    const root = await tempDir("mcode-file-effects-rename-");
    await writeFile(join(root, "old.txt"), "one\n");
    const tracker = trackerWithBaseline({ "old.txt": "one\n", "new.txt": null }, []);
    await tracker.beginTurn("t", root, "before");
    await tracker.observeToolUse("t", "rename", "Move", {
      from: join(".", "old.txt"),
      to: "new.txt",
    });
    await rename(join(root, "old.txt"), join(root, "new.txt"));
    await tracker.observeToolResult("t", "rename");

    expect(await tracker.finalizeTurn("t")).toMatchObject({
      fileCount: 1,
      additions: 0,
      deletions: 0,
      effects: [{ path: "new.txt", oldPath: "old.txt", kind: "renamed" }],
    });
  });

  it("does not label a copy as a rename when the normalized source still exists", async () => {
    const root = await tempDir("mcode-file-effects-invalid-rename-");
    await writeFile(join(root, "old.txt"), "one\n");
    const tracker = trackerWithBaseline({ "old.txt": "one\n", "new.txt": null }, []);
    await tracker.beginTurn("t", root, "before");
    await tracker.observeToolUse("t", "copy", "Move", {
      from: "old.txt",
      to: join(".", "new.txt"),
    });
    await writeFile(join(root, "new.txt"), "one\n");
    await tracker.observeToolResult("t", "copy");

    expect((await tracker.finalizeTurn("t")).effects).toEqual([
      expect.objectContaining({ path: "new.txt", kind: "added" }),
    ]);
  });

  it("coalesces bounded hash-matched remove/add pairs one-to-one", async () => {
    const root = await tempDir("mcode-file-effects-hash-renames-");
    const changes: Array<{ path: string; kind: string }> = [];
    const baseline: Record<string, string | null> = {};
    for (let index = 0; index < 8; index += 1) {
      const oldPath = `old-${index}.txt`;
      const newPath = `new-${index}.txt`;
      const content = `unique-${index}\n`;
      baseline[oldPath] = content;
      baseline[newPath] = null;
      changes.push({ path: oldPath, kind: "remove" }, { path: newPath, kind: "add" });
      await writeFile(join(root, oldPath), content);
    }
    const tracker = trackerWithBaseline(baseline, []);
    await tracker.beginTurn("t", root, "before");
    await tracker.observeToolUse("t", "move-batch", "file_change", { changes });
    await Promise.all(Array.from({ length: 8 }, (_, index) => (
      rename(join(root, `old-${index}.txt`), join(root, `new-${index}.txt`))
    )));
    await tracker.observeToolResult("t", "move-batch");

    const summary = await tracker.finalizeTurn("t");
    expect(summary.fileCount).toBe(8);
    expect(summary.additions).toBe(0);
    expect(summary.deletions).toBe(0);
    expect(summary.effects).toEqual(Array.from({ length: 8 }, (_, index) => expect.objectContaining({
      path: `new-${index}.txt`,
      oldPath: `old-${index}.txt`,
      kind: "renamed",
    })));
  });

  it.each([
    { label: "added", before: "", after: "one\n", additions: 1, deletions: 0 },
    { label: "removed", before: "one\n", after: "", additions: 0, deletions: 1 },
    { label: "edited", before: "one\n", after: "two\n", additions: 1, deletions: 1 },
  ])("uses Git-style trailing-newline totals for $label files", async ({ before, after, additions, deletions }) => {
    const root = await tempDir("mcode-file-effects-lines-");
    if (before !== "") await writeFile(join(root, "lines.txt"), before);
    const tracker = trackerWithBaseline({ "lines.txt": before === "" ? null : before }, []);
    await tracker.beginTurn("t", root, "before");
    await tracker.observeToolUse("t", "lines", before === "" ? "Write" : after === "" ? "Delete" : "Edit", {
      file_path: "lines.txt",
    });
    if (after === "") await rm(join(root, "lines.txt"), { force: true });
    else await writeFile(join(root, "lines.txt"), after);
    await tracker.observeToolResult("t", "lines");
    expect((await tracker.finalizeTurn("t")).effects[0]).toMatchObject({ additions, deletions });
  });

  it.each([
    { label: "added", before: "one", after: "one\n" },
    { label: "removed", before: "one\n", after: "one" },
  ])("counts an EOF newline $label as one added and one removed line", async ({ before, after }) => {
    const root = await tempDir("mcode-file-effects-eof-newline-");
    await writeFile(join(root, "lines.txt"), before);
    const tracker = trackerWithBaseline({ "lines.txt": before }, []);
    await tracker.beginTurn("t", root, "before");
    await tracker.observeToolUse("t", "lines", "Edit", { file_path: "lines.txt" });
    await writeFile(join(root, "lines.txt"), after);
    await tracker.observeToolResult("t", "lines");
    expect((await tracker.finalizeTurn("t")).effects[0]).toMatchObject({
      additions: 1,
      deletions: 1,
    });
  });
});
