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

function toolInputFromDiffs(diffs: readonly AcpDiffBlock[]): Record<string, unknown> | undefined {
  const diff = diffs[0];
  if (!diff) return undefined;
  return {
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
}

function readToolPath(
  inputRec: Record<string, unknown> | undefined,
  outputRec: Record<string, unknown> | undefined,
  marker: PendingAcpToolMarker | undefined,
): string | undefined {
  const outputPath = pickString(outputRec, ["path", "file_path", "filePath", "uri", "target_file"]);
  if (outputPath) return outputPath;
  const inputPath = pickString(inputRec, ["path", "file_path", "filePath", "uri", "target_file"]);
  if (inputPath) return inputPath;
  if (!titleLooksLikePath(marker?.title)) return undefined;
  return marker?.title?.trim();
}

function enrichReadToolInput(
  toolInput: Record<string, unknown>,
  inputRec: Record<string, unknown> | undefined,
  outputRec: Record<string, unknown> | undefined,
  marker: PendingAcpToolMarker | undefined,
): Record<string, unknown> {
  const filePath = readToolPath(inputRec, outputRec, marker);
  if (filePath) toolInput.file_path = filePath;
  else if (!toolInput.file_path) toolInput.file_path = "";
  return toolInput;
}

function enrichGrepToolInput(
  toolInput: Record<string, unknown>,
  inputRec: Record<string, unknown> | undefined,
  outputRec: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const pattern =
    pickString(inputRec, ["pattern", "query", "search", "regex", "rgPattern"]) ??
    pickString(outputRec, ["pattern", "query", "search", "regex"]);
  const path =
    pickString(inputRec, ["path", "file_path", "glob", "include", "cwd"]) ??
    pickString(outputRec, ["path", "file_path", "glob", "include"]);
  if (pattern) toolInput.pattern = pattern;
  if (path) toolInput.path = path;
  const totalMatches = outputRec?.totalMatches;
  if (!pattern && typeof totalMatches === "number" && Number.isFinite(totalMatches)) {
    toolInput.pattern = `${totalMatches} match${totalMatches === 1 ? "" : "es"}`;
  }
  return toolInput;
}

function enrichBashToolInput(
  toolInput: Record<string, unknown>,
  inputRec: Record<string, unknown> | undefined,
  outputRec: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const command = pickString(inputRec, ["command", "cmd"]) ?? pickString(outputRec, ["command", "cmd"]);
  if (command) toolInput.command = command;
  return toolInput;
}

function enrichWriteToolInput(
  toolInput: Record<string, unknown>,
  inputRec: Record<string, unknown> | undefined,
  outputRec: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!outputRec) return toolInput;
  const filePath =
    pickString(outputRec, ["path", "file_path", "filePath"]) ??
    pickString(inputRec, ["path", "file_path", "filePath"]);
  if (filePath) toolInput.file_path = filePath;
  if (typeof outputRec.content === "string") toolInput.content = outputRec.content;
  return toolInput;
}

function enrichNonDiffToolInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  inputRec: Record<string, unknown> | undefined,
  outputRec: Record<string, unknown> | undefined,
  marker: PendingAcpToolMarker | undefined,
): Record<string, unknown> {
  switch (toolName) {
    case "Read":
      return enrichReadToolInput(toolInput, inputRec, outputRec, marker);
    case "Grep":
      return enrichGrepToolInput(toolInput, inputRec, outputRec);
    case "Bash":
      return enrichBashToolInput(toolInput, inputRec, outputRec);
    case "Write":
      return enrichWriteToolInput(toolInput, inputRec, outputRec);
    default:
      return toolInput;
  }
}

function normalizeFileMutationToolInput(
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  return toolName === "Edit" || toolName === "Write"
    ? normalizeMcodeCursorToolInput(toolName, toolInput)
    : toolInput;
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
  const diffToolInput = toolInputFromDiffs(diffs);
  if (diffToolInput) toolInput = diffToolInput;
  else toolInput = enrichNonDiffToolInput(toolName, toolInput, inputRec, outputRec, marker);
  return normalizeFileMutationToolInput(toolName, toolInput);
}

function formatDiffToolResult(toolName: string, diffs: readonly AcpDiffBlock[]): string | undefined {
  const diff = diffs[0];
  if (!diff) return undefined;
  const label = toolName === "Write" ? "Wrote" : "Applied edit to";
  return `${label} ${diff.path}`;
}

function formatCommandToolResult(outputRec: Record<string, unknown>): string | undefined {
  if (!("stdout" in outputRec) && !("exitCode" in outputRec)) return undefined;
  const parts: string[] = [];
  if (typeof outputRec.stdout === "string" && outputRec.stdout) parts.push(outputRec.stdout);
  if (typeof outputRec.stderr === "string" && outputRec.stderr) parts.push(`stderr: ${outputRec.stderr}`);
  if (typeof outputRec.exitCode === "number" && outputRec.exitCode !== 0) {
    parts.push(`exit code: ${outputRec.exitCode}`);
  }
  return parts.join("\n");
}

function safelySerializeAcpOutput(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatRecordToolResult(toolName: string, outputRec: Record<string, unknown>): string {
  if (typeof outputRec.content === "string") return outputRec.content;
  const commandResult = formatCommandToolResult(outputRec);
  if (commandResult !== undefined) return commandResult;
  if (toolName === "Grep" && typeof outputRec.totalMatches === "number") {
    return JSON.stringify(outputRec);
  }
  const body = outputRec.success ?? outputRec.rejected ?? outputRec.failure;
  if (body != null) return typeof body === "string" ? body : JSON.stringify(body);
  return safelySerializeAcpOutput(outputRec);
}

function formatUnknownToolResult(rawOutput: unknown): string {
  if (typeof rawOutput === "string") return rawOutput;
  if (rawOutput === undefined || rawOutput === null) return "";
  return safelySerializeAcpOutput(rawOutput);
}

/**
 * Formats tool result text from ACP `rawOutput` and diff metadata.
 */
export function formatAcpToolResultOutput(
  toolName: string,
  rawOutput: unknown,
  diffs: readonly AcpDiffBlock[],
): string {
  const diffOutput = formatDiffToolResult(toolName, diffs);
  if (diffOutput !== undefined) return diffOutput;
  const outputRec = asRecord(rawOutput);
  return outputRec
    ? formatRecordToolResult(toolName, outputRec)
    : formatUnknownToolResult(rawOutput);
}
