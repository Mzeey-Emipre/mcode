/**
 * Attachment persistence service.
 * Handles copying, validating, and storing file attachments for threads.
 * Extracted from the attachment handling in apps/desktop/src/main/app-state.ts.
 */

import { injectable } from "tsyringe";
import { randomUUID } from "crypto";
import { existsSync, statSync, rmSync, copyFileSync, mkdirSync } from "fs";
import { copyFile, mkdir, unlink } from "fs/promises";
import { basename, extname, join, resolve, relative } from "path";
import { getMcodeDir } from "@mcode/shared";
import type { AttachmentMeta, StoredAttachment } from "@mcode/contracts";
import {
  getAttachmentMaxSizeForMime,
  isVirtualBrowserContextAttachment,
  MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
  shouldPersistAttachmentWithoutFile,
  storedAttachmentSuffix,
} from "@mcode/contracts";

const MAX_GENERATED_IMAGE_SIZE = 16 * 1024 * 1024;

/**
 * Pattern matching safe attachment IDs: alphanumerics, hyphens, and underscores only.
 * Prevents path traversal via crafted IDs containing `../` or other special characters.
 */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Return the stored MIME type for supported image file extensions. */
export function imageMimeTypeFromPath(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return null;
}

/** Resolve the base directory for attachment storage. */
function getAttachmentsDir(): string {
  return join(getMcodeDir(), "attachments");
}

function assertSafeId(kind: string, value: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${kind}: ${value}. Only alphanumerics, hyphens, and underscores are allowed.`,
    );
  }
}

function resolveStoredAttachmentPath(baseDir: string, id: string, mimeType: string): string {
  const ext = storedAttachmentSuffix(mimeType);
  if (!ext) throw new Error(`Unsupported attachment MIME type: ${mimeType}`);
  const destPath = resolve(baseDir, `${id}${ext}`);
  const rel = relative(baseDir, destPath);
  if (rel.startsWith("..") || resolve(baseDir, rel) !== destPath) {
    throw new Error(`Attachment path escapes thread directory: ${id}`);
  }
  return destPath;
}

function displayNameFromPath(filePath: string): string {
  const name = basename(filePath).replace(/[\x00-\x1f\x7f]/g, "").trim();
  return name.length > 0 ? name : "generated-image";
}

/** Persists and reads file attachments for agent threads. */
@injectable()
export class AttachmentService {
  /** Rebuild outbound attachment metadata from Mcode-owned stored files for an explicit Retry. */
  prepareRetryAttachments(
    threadId: string,
    attachments: readonly StoredAttachment[],
  ): AttachmentMeta[] {
    assertSafeId("thread ID", threadId);
    const baseDir = join(getAttachmentsDir(), threadId);
    return attachments.map((attachment) => {
      assertSafeId("attachment ID", attachment.id);
      if (shouldPersistAttachmentWithoutFile({ ...attachment, sourcePath: "" })) {
        return { ...attachment, id: randomUUID(), sourcePath: "" };
      }
      const sourcePath = resolveStoredAttachmentPath(baseDir, attachment.id, attachment.mimeType);
      if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
        throw new Error(`Stored attachment file not found: ${attachment.id}`);
      }
      return { ...attachment, id: randomUUID(), sourcePath };
    });
  }

  /**
   * Copy and validate attachments for a thread.
   * Returns both stored metadata (for DB) and persisted metadata (with new paths).
   */
  async persist(
    threadId: string,
    attachments: AttachmentMeta[],
  ): Promise<{
    stored: StoredAttachment[];
    persisted: AttachmentMeta[];
  }> {
    if (attachments.length === 0) return { stored: [], persisted: [] };

    const baseDir = join(getAttachmentsDir(), threadId);
    await mkdir(baseDir, { recursive: true });

    const results = await Promise.all(
      attachments.map(async (att) => {
        if (shouldPersistAttachmentWithoutFile(att)) {
          if (!SAFE_ID_PATTERN.test(att.id)) {
            throw new Error(
              `Invalid attachment ID: ${att.id}. Only alphanumerics, hyphens, and underscores are allowed.`,
            );
          }
          const mime = isVirtualBrowserContextAttachment(att.mimeType)
            ? att.mimeType.trim()
            : MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME;
          return {
            stored: {
              id: att.id,
              name: att.name,
              mimeType: mime,
              sizeBytes: 0,
            } as StoredAttachment,
            persisted: null as AttachmentMeta | null,
          };
        }

        if (!existsSync(att.sourcePath)) {
          throw new Error(`Attachment file not found: ${att.sourcePath}`);
        }

        const actualSize = statSync(att.sourcePath).size;
        const maxSize = getAttachmentMaxSizeForMime(att.mimeType);
        if (actualSize > maxSize) {
          throw new Error(
            `Attachment "${att.name}" exceeds ${maxSize} byte limit (actual: ${actualSize})`,
          );
        }

        // Validate attachment ID to prevent path traversal
        assertSafeId("attachment ID", att.id);
        const destPath = resolveStoredAttachmentPath(baseDir, att.id, att.mimeType);

        await copyFile(att.sourcePath, destPath);

        // Clean up temp file if it came from a known temp location
        const tempDir = resolve(getMcodeDir(), "temp", "attachments");
        const resolvedSource = resolve(att.sourcePath);
        const tempRel = relative(tempDir, resolvedSource);
        if (!tempRel.startsWith("..") && !resolve(tempDir, tempRel).includes("..")) {
          try {
            await unlink(att.sourcePath);
          } catch {
            /* non-fatal */
          }
        }

        return {
          stored: {
            id: att.id,
            name: att.name,
            mimeType: att.mimeType,
            sizeBytes: actualSize,
          } as StoredAttachment,
          persisted: {
            ...att,
            sourcePath: destPath,
            sizeBytes: actualSize,
          } as AttachmentMeta,
        };
      }),
    );

    return {
      stored: results.map((r) => r.stored),
      persisted: results.map((r) => r.persisted).filter((p): p is AttachmentMeta => p != null),
    };
  }

  /** Remove only the Mcode-owned files for the specified stored attachments. */
  async removeStoredAttachments(threadId: string, attachments: readonly StoredAttachment[]): Promise<void> {
    assertSafeId("thread ID", threadId);
    const baseDir = join(getAttachmentsDir(), threadId);
    await Promise.all(attachments.map(async (attachment) => {
      assertSafeId("attachment ID", attachment.id);
      if (shouldPersistAttachmentWithoutFile({ ...attachment, sourcePath: "" })) return;
      const storedPath = resolveStoredAttachmentPath(baseDir, attachment.id, attachment.mimeType);
      try {
        await unlink(storedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }));
  }

  /** Copy a Codex-generated image into Mcode-managed attachment storage. */
  persistGeneratedImageFromPath(threadId: string, sourcePath: string): StoredAttachment {
    assertSafeId("thread ID", threadId);

    const mimeType = imageMimeTypeFromPath(sourcePath);
    if (!mimeType) {
      throw new Error("Generated image has an unsupported file extension");
    }
    if (!existsSync(sourcePath)) {
      throw new Error("Generated image file not found");
    }

    const stat = statSync(sourcePath);
    if (!stat.isFile()) {
      throw new Error("Generated image source is not a file");
    }
    if (stat.size > MAX_GENERATED_IMAGE_SIZE) {
      throw new Error(
        `Generated image exceeds ${MAX_GENERATED_IMAGE_SIZE} byte limit (actual: ${stat.size})`,
      );
    }

    const id = randomUUID();
    const baseDir = join(getAttachmentsDir(), threadId);
    mkdirSync(baseDir, { recursive: true });
    const destPath = resolveStoredAttachmentPath(baseDir, id, mimeType);
    copyFileSync(sourcePath, destPath);

    return {
      id,
      name: displayNameFromPath(sourcePath),
      mimeType,
      sizeBytes: stat.size,
    };
  }

  /** Remove all attachments for a thread from disk. */
  removeForThread(threadId: string): void {
    // Validate threadId to prevent path traversal via crafted IDs like "../"
    if (!SAFE_ID_PATTERN.test(threadId)) {
      throw new Error(
        `Invalid thread ID: ${threadId}. Only alphanumerics, hyphens, and underscores are allowed.`,
      );
    }

    const attachmentsBase = getAttachmentsDir();
    const dir = resolve(attachmentsBase, threadId);

    // Verify the resolved path stays within the attachments directory
    const rel = relative(attachmentsBase, dir);
    if (rel.startsWith("..") || resolve(attachmentsBase, rel) !== dir) {
      throw new Error(`Thread attachment path escapes attachments directory: ${threadId}`);
    }

    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Non-fatal
      }
    }
  }
}
