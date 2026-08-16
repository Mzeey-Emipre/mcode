/**
 * Filesystem-backed read/write for handoff artifacts.
 *
 * Each handoff is a ULID-named directory containing handoff.md (with YAML
 * frontmatter) and handoff.json (system metadata, provenance, and attachment
 * manifest). ULID ordering makes "latest handoff" a simple sort.
 */

import { mkdir, readFile, writeFile, readdir, rm, copyFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { dirname, extname, join } from "path";
import { createHash } from "crypto";
import { injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import {
  getMcodeDir,
  newHandoffUlid,
  resolveHandoffDir,
  resolveThreadAttachmentsDir,
  resolveThreadHandoffsDir,
} from "@mcode/shared";
import type { HandoffArtifact, HandoffMeta } from "./handoff-types.js";

/** A single file to be copied into the thread's attachments directory. */
export interface AttachmentSource {
  id: string;
  absolutePath: string;
  originalName: string;
  mime: string;
  parentMessageId: string;
}

/** Attachments larger than this are skipped during copy to avoid blowing storage budgets. */
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

@injectable()
export class HandoffStorage {
  // Parameterless constructor: tsyringe can resolve `@injectable()` classes only
  // when every constructor parameter has a registered token. Function-typed
  // defaults broke DI ("TypeInfo not known for Function"). Production callers
  // get the real resolvers; tests override via `forTesting()`.
  private mcodeDirFn: () => string = getMcodeDir;
  private statFn: (path: string) => Promise<{ size: number }> = stat;

  /**
   * Test-only constructor override. Allows injecting a fake `mcodeDirFn`
   * (e.g. pointing at a tmpdir) and/or a fake `statFn` (e.g. to simulate
   * oversized files without writing real bytes).
   */
  static forTesting(overrides: {
    mcodeDirFn?: () => string;
    statFn?: (path: string) => Promise<{ size: number }>;
  }): HandoffStorage {
    const s = new HandoffStorage();
    if (overrides.mcodeDirFn) s.mcodeDirFn = overrides.mcodeDirFn;
    if (overrides.statFn) s.statFn = overrides.statFn;
    return s;
  }

  /** Persist an artifact under a fresh ULID. Returns the ULID assigned. */
  async write(threadId: string, artifact: HandoffArtifact): Promise<string> {
    const ulid = newHandoffUlid();
    const handoffDir = resolveHandoffDir(this.mcodeDirFn(), threadId, ulid);
    await mkdir(handoffDir, { recursive: true });

    const markdownWithFrontmatter = this.injectFrontmatter(artifact.markdown, artifact.meta);
    await writeFile(join(handoffDir, "handoff.md"), markdownWithFrontmatter, "utf8");
    await writeFile(join(handoffDir, "handoff.json"), JSON.stringify(artifact.meta, null, 2), "utf8");
    return ulid;
  }

  /** Most recent handoff by ULID lexicographic sort (ULIDs are time-ordered). */
  async readLatest(threadId: string): Promise<HandoffArtifact | null> {
    const handoffsRoot = resolveThreadHandoffsDir(this.mcodeDirFn(), threadId);
    if (!existsSync(handoffsRoot)) return null;
    const entries = await readdir(handoffsRoot);
    if (entries.length === 0) return null;
    const latest = entries.sort().at(-1);
    if (!latest) return null;
    const dir = join(handoffsRoot, latest);
    const [md, json] = await Promise.all([
      readFile(join(dir, "handoff.md"), "utf8"),
      readFile(join(dir, "handoff.json"), "utf8"),
    ]);
    return { markdown: md, meta: JSON.parse(json) as HandoffMeta };
  }

  /** Copy source files into <thread>/attachments/<id>.<ext>. */
  async copyAttachments(threadId: string, sources: AttachmentSource[]): Promise<HandoffMeta["attachments"]> {
    const attachDir = resolveThreadAttachmentsDir(this.mcodeDirFn(), threadId);
    await mkdir(attachDir, { recursive: true });
    const result: HandoffMeta["attachments"] = [];
    for (const s of sources) {
      const fileStat = await this.statFn(s.absolutePath);
      if (fileStat.size > ATTACHMENT_MAX_BYTES) {
        logger.warn("Attachment exceeds size cap; skipping copy", {
          id: s.id,
          sizeBytes: fileStat.size,
          max: ATTACHMENT_MAX_BYTES,
        });
        result.push({
          id: s.id,
          originalName: s.originalName,
          sha256: "<skipped>",
          mime: s.mime,
          parentMessageId: s.parentMessageId,
        });
        continue;
      }
      const ext = extname(s.originalName) || extname(s.absolutePath) || "";
      const dest = join(attachDir, `${s.id}${ext}`);
      await copyFile(s.absolutePath, dest);
      const sha = createHash("sha256").update(await readFile(dest)).digest("hex");
      result.push({
        id: s.id,
        originalName: s.originalName,
        sha256: sha,
        mime: s.mime,
        parentMessageId: s.parentMessageId,
      });
    }
    return result;
  }

  /** Wipe the entire <mcodeDir>/threads/<id>/ subtree. Called on thread hard delete. */
  async deleteThreadFiles(threadId: string): Promise<void> {
    const threadRoot = dirname(resolveThreadHandoffsDir(this.mcodeDirFn(), threadId));
    await rm(threadRoot, { recursive: true, force: true });
  }

  private injectFrontmatter(markdownBody: string, meta: HandoffMeta): string {
    const fmFields = [
      `schemaVersion: ${meta.schemaVersion}`,
      `parentThreadId: ${meta.parentThreadId}`,
      `forkedFromMessageId: ${meta.forkedFromMessageId}`,
      `forkAnchorRole: ${meta.forkAnchorRole}`,
      `childThreadId: ${meta.childThreadId}`,
      `generatedBy: ${meta.generatedBy}`,
      `provider: ${meta.provider ?? "null"}`,
      `ladderStep: ${meta.ladderStep}`,
      `mode: ${meta.mode}`,
      `generatedAt: ${meta.generatedAt}`,
      `characterCount: ${meta.characterCount}`,
    ].join("\n");
    // Only strip frontmatter that carries a known handoff key to avoid eating
    // valid markdown content that starts with an unrelated YAML-looking block.
    const body = markdownBody.replace(
      /^---\n(?=[\s\S]*?\b(schemaVersion|parentThreadId|forkedFromMessageId):)[\s\S]*?\n---\n/,
      "",
    );
    return `---\n${fmFields}\n---\n\n${body}`;
  }
}
