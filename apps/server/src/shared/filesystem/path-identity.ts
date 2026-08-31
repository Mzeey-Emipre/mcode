import * as NodePath from "node:path";
import * as NodeFS from "node:fs";

/** Remove the Windows extended-length namespace while preserving the filesystem path. */
export function stripWindowsPathNamespace(value: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return value;
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/i.test(value)) return value.slice(4);
  return value;
}

/** Normalize a path for identity comparisons across Windows path spellings. */
export function normalizePathForComparison(value: string, platform: NodeJS.Platform): string {
  const normalized = canonicalizePathForComparison(value, platform)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Resolve existing Windows path segments so short and long aliases share one identity. */
function canonicalizePathForComparison(value: string, platform: NodeJS.Platform): string {
  const lexical = NodePath.resolve(stripWindowsPathNamespace(value, platform));
  if (platform !== "win32") return lexical;

  let cursor = lexical;
  const missing: string[] = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      return NodePath.resolve(stripWindowsPathNamespace(NodeFS.realpathSync.native(cursor), platform), ...missing);
    } catch {
      const parent = NodePath.dirname(cursor);
      if (parent === cursor) return lexical;
      missing.unshift(NodePath.basename(cursor));
      cursor = parent;
    }
  }
  return lexical;
}

/** Normalize a canonical path for filesystem operations without changing its casing. */
export function normalizeFilesystemPath(value: string, platform: NodeJS.Platform): string {
  return NodePath.resolve(stripWindowsPathNamespace(value, platform));
}
