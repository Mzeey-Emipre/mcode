import { createTwoFilesPatch } from "diff";

/** Serialize bounded full-file evidence, preserving empty files and final newlines. */
export function createTextPatch(path: string, before: string, after: string, kind: "edited" | "added" | "removed" = "edited"): string | undefined {
  if (!path || /[\x00-\x1f"\\]/.test(path) || path.length > 4096) return undefined;
  if (Buffer.byteLength(before) + Buffer.byteLength(after) > 2_097_152) return undefined;
  if (before === after) return "";
  const names = patchNames(path, kind);
  const patch = createTwoFilesPatch(names.before, names.after, before, after, undefined, undefined, {
    context: 3,
    timeout: 100,
    maxEditLength: 20_000,
    headerOptions: { includeIndex: false, includeUnderline: false, includeFileHeaders: true },
  });
  if (patch === undefined) return undefined;
  const result = `diff --git a/${path} b/${path}\n${patch}`;
  return Buffer.byteLength(result) <= 2_097_152 ? result : undefined;
}

function patchNames(path: string, kind: "edited" | "added" | "removed"): { before: string; after: string } {
  return { before: kind === "added" ? "/dev/null" : `a/${path}`, after: kind === "removed" ? "/dev/null" : `b/${path}` };
}
