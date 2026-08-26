/**
 * @internal
 * Builds Mcode toolInput from ACP `tool_call` / `tool_call_update` payloads when
 * lifecycle markers omit args on the initial `tool_call`.
 */

import { normalizeMcodeCursorToolInput } from "../events/cursor-tool-input-normalize.js";

/** ACP diff block on `tool_call_update.content`. */
export interface AcpDiffBlock {
  type: "diff";
  path: string;
  oldText: string;
  newText: string;
}

/** Context cached from the initial `tool_call` marker. */
export interface PendingAcpToolMarker {
  kind?: string;
  title?: string | null;
}

/** Returns the first non-empty string value for any of the given keys. */
function pickString(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Narrows an unknown value to a plain object record when safe. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Returns true when a title looks like a filesystem path rather than a generic label.
 */
function titleLooksLikePath(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.trim();
  if (t === "Read File" || t === "Edit File" || t === "Write File") return false;
  if (t === "grep" || t === "Glob" || t === "Find") return false;
  return t.includes("/") || t.includes("\\") || /\.[a-zA-Z0-9]+$/.test(t);
}

/**
 * Merges ACP completion data into toolInput for deferred or thin lifecycle tool calls.
 *
 * @param toolName - Resolved Mcode tool name.
 * @param marker - Cached kind/title from the initial `tool_call`.
 * @param rawInput - Optional `rawInput` on the update envelope.
 * @param rawOutput - Optional `rawOutput` on the update envelope.
 * @param diffs - Parsed `content` diff blocks, when present.
 */
export function enrichAcpToolInput(
  toolName: string,
  marker: PendingAcpToolMarker | undefined,
  rawInput: unknown,
  rawOutput: unknown,
  diffs: readonly AcpDiffBlock[],
): Record<string, unknown> {
  const inputRec = asRecord(rawInput);
  const outputRec = asRecord(rawOutput);
  let toolInput: Record<string, unknown> = inputRec ? { ...inputRec } : {};

  if (diffs.length > 0) {
    const diff = diffs[0];
    toolInput = {
      file_path: diff.path,
      old_string: diff.oldText,
      new_string: diff.newText,
      _mcodeFileMutations: diffs.slice(0, 256).map((item) => ({
        path: item.path,
        kind: item.oldText.length === 0 ? "add" : item.newText.length === 0 ? "remove" : "edit",
        fullFileContent: true,
        beforeText: item.oldText,
        afterText: item.newText,
      })),
    };
  } else if (toolName === "Read") {
    const filePath =
      pickString(outputRec, ["path", "file_path", "filePath", "uri", "target_file"]) ??
      pickString(inputRec, ["path", "file_path", "filePath", "uri", "target_file"]) ??
      (titleLooksLikePath(marker?.title) ? marker!.title!.trim() : undefined);
    if (filePath) toolInput.file_path = filePath;
    else if (!toolInput.file_path) toolInput.file_path = "";
  } else if (toolName === "Grep") {
    const pattern =
      pickString(inputRec, ["pattern", "query", "search", "regex", "rgPattern"]) ??
      pickString(outputRec, ["pattern", "query", "search", "regex"]);
    const path =
      pickString(inputRec, ["path", "file_path", "glob", "include", "cwd"]) ??
      pickString(outputRec, ["path", "file_path", "glob", "include"]);
    if (pattern) toolInput.pattern = pattern;
    if (path) toolInput.path = path;
    const totalMatches = outputRec?.totalMatches;
    if (
      !pattern &&
      typeof totalMatches === "number" &&
      Number.isFinite(totalMatches)
    ) {
      toolInput.pattern = `${totalMatches} match${totalMatches === 1 ? "" : "es"}`;
    }
  } else if (toolName === "Bash") {
    const command =
      pickString(inputRec, ["command", "cmd"]) ??
      pickString(outputRec, ["command", "cmd"]);
    if (command) toolInput.command = command;
  } else if (toolName === "Write" && outputRec) {
    const filePath =
      pickString(outputRec, ["path", "file_path", "filePath"]) ??
      pickString(inputRec, ["path", "file_path", "filePath"]);
    if (filePath) toolInput.file_path = filePath;
    if (typeof outputRec.content === "string") toolInput.content = outputRec.content;
  }

  if (toolName === "Edit" || toolName === "Write") {
    return normalizeMcodeCursorToolInput(toolName, toolInput);
  }
  return toolInput;
}

/**
 * Formats tool result text from ACP `rawOutput` and diff metadata.
 */
export function formatAcpToolResultOutput(
  toolName: string,
  rawOutput: unknown,
  diffs: readonly AcpDiffBlock[],
): string {
  if (diffs.length > 0) {
    const diff = diffs[0];
    const label = toolName === "Write" ? "Wrote" : "Applied edit to";
    return `${label} ${diff.path}`;
  }

  const outputRec = asRecord(rawOutput);
  if (!outputRec) {
    if (typeof rawOutput === "string") return rawOutput;
    if (rawOutput !== undefined && rawOutput !== null) {
      try {
        return JSON.stringify(rawOutput);
      } catch {
        return String(rawOutput);
      }
    }
    return "";
  }

  if (typeof outputRec.content === "string") {
    return outputRec.content;
  }

  if ("stdout" in outputRec || "exitCode" in outputRec) {
    const parts: string[] = [];
    if (typeof outputRec.stdout === "string" && outputRec.stdout) parts.push(outputRec.stdout);
    if (typeof outputRec.stderr === "string" && outputRec.stderr) {
      parts.push(`stderr: ${outputRec.stderr}`);
    }
    if (typeof outputRec.exitCode === "number" && outputRec.exitCode !== 0) {
      parts.push(`exit code: ${outputRec.exitCode}`);
    }
    return parts.join("\n");
  }

  if (toolName === "Grep" && typeof outputRec.totalMatches === "number") {
    return JSON.stringify(outputRec);
  }

  const body = outputRec.success ?? outputRec.rejected ?? outputRec.failure;
  if (body != null) {
    return typeof body === "string" ? body : JSON.stringify(body);
  }

  try {
    return JSON.stringify(outputRec);
  } catch {
    return String(outputRec);
  }
}
