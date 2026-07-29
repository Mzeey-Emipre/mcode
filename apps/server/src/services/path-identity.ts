import { basename, dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";

/** Remove the Windows extended-length namespace while preserving the filesystem path. */
export function stripWindowsPathNamespace(value: string): string {
  if (process.platform !== "win32") return value;
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/i.test(value)) return value.slice(4);
  return value;
}

/** Normalize a path for identity comparisons across Windows path spellings. */
export function normalizePathForComparison(value: string): string {
  const normalized = canonicalizePathForComparison(value)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Resolve existing Windows path segments so short and long aliases share one identity. */
function canonicalizePathForComparison(value: string): string {
  const lexical = resolve(stripWindowsPathNamespace(value));
  if (process.platform !== "win32") return lexical;

  let cursor = lexical;
  const missing: string[] = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      return resolve(stripWindowsPathNamespace(realpathSync.native(cursor)), ...missing);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return lexical;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
  return lexical;
}

/** Normalize a canonical path for filesystem operations without changing its casing. */
export function normalizeFilesystemPath(value: string): string {
  return resolve(stripWindowsPathNamespace(value));
}
