import * as NodePath from "node:path";
import { createTextPatch } from "@mcode/shared";
import type { SessionNotification } from "@agentclientprotocol/sdk";

const MAX_NATIVE_PATCH_BYTES = 2_097_152;

export type CursorNativeTurnDiffResult = { state: "snapshot"; patch: string } | { state: "indeterminate-empty" } | { state: "rejected" };

/** Builds one complete, bounded native patch from Cursor ACP full-file edit blocks. */
export class CursorNativeTurnDiff {
  private readonly files = new Map<string, { before: string; after: string; added: boolean }>();
  private contentBytes = 0;
  private rejected = false;
  private readonly pending = new Map<string, { edit: boolean; blocks: Array<{ path: string; oldText: string | null; newText: string }> }>();

  /** Retain full blocks across ACP updates and admit them only after tool success. */
  observe(cwd: string, update: SessionNotification["update"]): CursorNativeTurnDiffResult | null {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return null;
    if (this.rejected) return { state: "rejected" };
    const pending = this.pending.get(update.toolCallId) ?? { edit: false, blocks: [] };
    if (update.kind) pending.edit = ["edit", "delete", "move"].includes(update.kind);
    const blocks = update.content?.filter((block) => block.type === "diff");
    if (blocks?.length) {
      const full = blocks.map((block) => fullFileBlock(cwd, block));
      if (full.some((block) => block === null)) return this.reject();
      pending.blocks = full.map((block) => ({ path: block!.path, oldText: block!.before, newText: block!.after }));
    }
    this.pending.set(update.toolCallId, pending);
    return this.finishUpdate(cwd, update.toolCallId, update.status);
  }

  private finishUpdate(cwd: string, id: string, status: string | null | undefined): CursorNativeTurnDiffResult | null {
    const pending = this.pending.get(id)!;
    const bytes = [...this.pending.values()].flatMap((entry) => entry.blocks)
      .reduce((total, block) => total + Buffer.byteLength(block.oldText ?? "") + Buffer.byteLength(block.newText), this.contentBytes);
    if (this.pending.size > 256 || bytes > MAX_NATIVE_PATCH_BYTES) return this.reject();
    if (status !== "completed" && status !== "failed") return null;
    this.pending.delete(id);
    if (status === "failed") return null;
    if (pending.edit && pending.blocks.length === 0) return this.reject();
    return this.push(cwd, pending.blocks);
  }

  /** Adds full before-and-after blocks, retaining the first before state for each file. */
  push(cwd: string, blocks: readonly unknown[]): CursorNativeTurnDiffResult | null {
    if (this.rejected) return { state: "rejected" };
    if (blocks.length === 0) return null;
    for (const raw of blocks) {
      const block = fullFileBlock(cwd, raw);
      if (!block || !this.addBlock(block)) return this.reject();
    }
    if ([...this.files.values()].some((file) => file.added && file.after === "")) return this.reject();
    if ([...this.files.values()].every((file) => file.before === file.after)) return { state: "indeterminate-empty" };
    const patches = [...this.files].map(([path, contents]) => createTextPatch(path, contents.before, contents.after, contents.added ? "added" : "edited"));
    if (patches.some((patch) => patch === undefined)) return this.reject();
    const patch = patches.join("");
    return Buffer.byteLength(patch) <= MAX_NATIVE_PATCH_BYTES ? { state: "snapshot", patch } : this.reject();
  }

  private addBlock(block: { path: string; before: string | null; after: string }): boolean {
    const previous = this.files.get(block.path);
    if (!previous && this.files.size >= 256) return false;
    if (previous && previous.after !== block.before) return false;
    const before = previous ? previous.before : (block.before ?? "");
    const nextBytes = this.contentBytes - (previous ? Buffer.byteLength(previous.before) + Buffer.byteLength(previous.after) : 0)
      + Buffer.byteLength(before) + Buffer.byteLength(block.after);
    if (nextBytes > MAX_NATIVE_PATCH_BYTES) return false;
    this.files.set(block.path, { before, after: block.after, added: previous ? previous.added : block.before === null });
    this.contentBytes = nextBytes;
    return true;
  }

  private reject(): CursorNativeTurnDiffResult {
    this.rejected = true;
    this.files.clear();
    this.pending.clear();
    this.contentBytes = 0;
    return { state: "rejected" };
  }
}

function fullFileBlock(cwd: string, raw: unknown): { path: string; before: string | null; after: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const block = raw as Record<string, unknown>;
  if (typeof block.path !== "string" || typeof block.newText !== "string") return null;
  const before = block.oldText === undefined ? null : block.oldText;
  if (before !== null && typeof before !== "string") return null;
  const path = workspacePath(cwd, block.path);
  return path ? { path, before, after: block.newText } : null;
}

function workspacePath(cwd: string, input: string): string | null {
  if (typeof input !== "string" || /[\x00-\x1f"\\]/.test(input.replaceAll("\\", "/")) || input.length > 4096) return null;
  const relative = NodePath.relative(cwd, NodePath.resolve(cwd, input)).replaceAll("\\", "/");
  if (!relative || NodePath.isAbsolute(relative) || relative.startsWith("../") || relative === ".." || relative.includes("\0")) return null;
  return relative;
}
