import { resolve } from "node:path";

/** Remove the Windows extended-length namespace while preserving the filesystem path. */
export function stripWindowsPathNamespace(value: string): string {
  if (process.platform !== "win32") return value;
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/i.test(value)) return value.slice(4);
  return value;
}

/** Normalize a path for identity comparisons across Windows path spellings. */
export function normalizePathForComparison(value: string): string {
  const normalized = resolve(stripWindowsPathNamespace(value))
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Normalize a canonical path for filesystem operations without changing its casing. */
export function normalizeFilesystemPath(value: string): string {
  return resolve(stripWindowsPathNamespace(value));
}
