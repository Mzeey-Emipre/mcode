import { createHash } from "crypto";
import { z } from "zod";
import {
  PULL_REQUEST_FILE_LOCATOR_MAX_LENGTH,
  PULL_REQUEST_FILE_MAX_COUNT,
  PULL_REQUEST_FILE_PATH_MAX_LENGTH,
  PULL_REQUEST_PATCH_MAX_BYTES,
  PULL_REQUEST_PATCH_MAX_LINE_LENGTH,
  PULL_REQUEST_PATCH_MAX_LINES,
  type PullRequestFileChangeType,
  type PullRequestFilePatchStatus,
} from "@mcode/contracts";
import type { PullRequestRemoteFile } from "./pull-request-remote.js";

const GIT_ATTRIBUTES_MAX_BYTES = 64 * 1_024;
const GIT_ATTRIBUTES_MAX_LINES = 2_000;
const GIT_ATTRIBUTES_MAX_LINE_LENGTH = 4_096;
const GIT_ATTRIBUTES_MAX_PATTERN_LENGTH = 256;
const GIT_ATTRIBUTES_MAX_GENERATED_RULES = 128;

const githubProjectedFileSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40,64}$/i),
  filename: z.string().min(1).max(4 * PULL_REQUEST_FILE_PATH_MAX_LENGTH),
  status: z.enum(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  changes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  previous_filename: z
    .string()
    .min(1)
    .max(4 * PULL_REQUEST_FILE_PATH_MAX_LENGTH)
    .nullable()
    .optional(),
  has_patch: z.boolean(),
});

const fileLocatorSchema = z.object({
  version: z.literal(1),
  position: z.number().int().min(0).max(PULL_REQUEST_FILE_MAX_COUNT - 1),
  fingerprint: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

/** Decoded server locator used to refetch one global GitHub file position. */
export interface PullRequestFileLocator {
  position: number;
  fingerprint: string;
}

/** Generated-attribute file fetched from one directory at an immutable head. */
export interface GithubGeneratedAttributeFile {
  directory: string;
  text: string;
}

/** Evidence available when GitHub omits a patch from its files response. */
export interface GithubPullRequestPatchEvidence {
  patch: string | null;
  oldText: string | null;
  newText: string | null;
  binary: boolean;
  generated: boolean;
  blobTooLarge: boolean;
}

/** Bounded provider-neutral patch value produced from GitHub evidence. */
export interface GithubNormalizedPullRequestPatch {
  status: PullRequestFilePatchStatus;
  patch: string | null;
  parsedLineCount: number | null;
}

function validRemotePath(path: string): boolean {
  return path.length > 0
    && path.length <= PULL_REQUEST_FILE_PATH_MAX_LENGTH
    && !/[\x00-\x1f\x7f]/.test(path);
}

function normalizeChangeType(status: z.infer<typeof githubProjectedFileSchema>["status"]): PullRequestFileChangeType {
  return status === "removed" ? "deleted" : status;
}

/** Normalize one statically projected GitHub changed-file record. */
export function normalizeGithubPullRequestFile(
  input: unknown,
  globalPosition: number,
): PullRequestRemoteFile | null {
  const parsed = githubProjectedFileSchema.safeParse(input);
  if (!parsed.success || !isValidGlobalFilePosition(globalPosition)) return null;
  const file = parsed.data;
  if (!hasValidGithubPullRequestFilePaths(file)) return null;
  return {
    globalPosition,
    path: file.filename,
    previousPath: file.previous_filename ?? null,
    changeType: normalizeChangeType(file.status),
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blobOid: file.sha,
    hasPatch: file.has_patch,
  };
}

function isValidGlobalFilePosition(globalPosition: number): boolean {
  return Number.isInteger(globalPosition)
    && globalPosition >= 0
    && globalPosition < PULL_REQUEST_FILE_MAX_COUNT;
}

function hasValidGithubPullRequestFilePaths(
  file: z.infer<typeof githubProjectedFileSchema>,
): boolean {
  if (!validRemotePath(file.filename)) return false;
  if (file.status === "renamed" && !file.previous_filename) return false;
  return !file.previous_filename || validRemotePath(file.previous_filename);
}

/** Return a stable metadata fingerprint for a global-position file locator. */
export function pullRequestRemoteFileFingerprint(file: PullRequestRemoteFile): string {
  return createHash("sha256").update(JSON.stringify({
    globalPosition: file.globalPosition,
    path: file.path,
    previousPath: file.previousPath,
    changeType: file.changeType,
    blobOid: file.blobOid,
  })).digest("base64url");
}

/** Create an opaque bounded locator for one normalized changed file. */
export function createPullRequestFileLocator(file: PullRequestRemoteFile): string {
  const locator = Buffer.from(JSON.stringify({
    version: 1,
    position: file.globalPosition,
    fingerprint: pullRequestRemoteFileFingerprint(file),
  }), "utf8").toString("base64url");
  if (locator.length > PULL_REQUEST_FILE_LOCATOR_MAX_LENGTH) {
    throw new Error("Pull request file locator exceeds its contract bound.");
  }
  return locator;
}

/** Decode and validate a server-issued changed-file locator. */
export function decodePullRequestFileLocator(locator: string): PullRequestFileLocator | null {
  if (locator.length < 1 || locator.length > PULL_REQUEST_FILE_LOCATOR_MAX_LENGTH) return null;
  try {
    const value = JSON.parse(Buffer.from(locator, "base64url").toString("utf8")) as unknown;
    const parsed = fileLocatorSchema.safeParse(value);
    return parsed.success
      ? { position: parsed.data.position, fingerprint: parsed.data.fingerprint }
      : null;
  } catch {
    return null;
  }
}

type AttributePatternToken =
  | { kind: "literal"; value: string }
  | { kind: "single" }
  | { kind: "star"; crossesDirectories: boolean };

function attributePatternTokens(pattern: string): AttributePatternToken[] | null {
  const normalized = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  if (
    !normalized
    || normalized.length > GIT_ATTRIBUTES_MAX_PATTERN_LENGTH
    || normalized.startsWith("!")
    || normalized.endsWith("/")
  ) {
    return null;
  }
  const tokens: AttributePatternToken[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const token = attributePatternTokenAt(normalized, index);
    tokens.push(token.value);
    index += token.consumed;
  }
  return tokens;
}

function attributePatternTokenAt(
  pattern: string,
  index: number,
): { value: AttributePatternToken; consumed: number } {
  const character = pattern[index];
  if (character === "\\" && pattern[index + 1]) {
    return { value: { kind: "literal", value: pattern[index + 1] }, consumed: 1 };
  }
  if (character === "*" && pattern[index + 1] === "*") {
    return { value: { kind: "star", crossesDirectories: true }, consumed: 1 };
  }
  if (character === "*") return { value: { kind: "star", crossesDirectories: false }, consumed: 0 };
  if (character === "?") return { value: { kind: "single" }, consumed: 0 };
  return { value: { kind: "literal", value: character }, consumed: 0 };
}

function relativeAttributePath(path: string, directory: string): string | null {
  const normalizedDirectory = directory.replace(/^\/+|\/+$/g, "");
  if (!normalizedDirectory) return path;
  const prefix = `${normalizedDirectory}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function patternMatchesPath(pattern: string, path: string): boolean {
  const tokens = attributePatternTokens(pattern);
  if (!tokens) return false;
  const candidate = pattern.includes("/") ? path : path.split("/").at(-1) ?? "";
  let previous = Array.from({ length: candidate.length + 1 }, () => false);
  previous[0] = true;
  for (const token of tokens) {
    previous = applyAttributePatternToken(token, candidate, previous);
  }
  return previous[candidate.length];
}

function applyAttributePatternToken(
  token: AttributePatternToken,
  candidate: string,
  previous: readonly boolean[],
): boolean[] {
  const next = Array.from({ length: candidate.length + 1 }, () => false);
  if (token.kind === "star") return applyAttributeStar(token, candidate, previous, next);
  for (let index = 1; index <= candidate.length; index += 1) {
    next[index] = previous[index - 1] && attributeTokenMatches(token, candidate[index - 1]);
  }
  return next;
}

function applyAttributeStar(
  token: Extract<AttributePatternToken, { kind: "star" }>,
  candidate: string,
  previous: readonly boolean[],
  next: boolean[],
): boolean[] {
  next[0] = previous[0];
  for (let index = 1; index <= candidate.length; index += 1) {
    next[index] = previous[index]
      || (next[index - 1] && (token.crossesDirectories || candidate[index - 1] !== "/"));
  }
  return next;
}

function attributeTokenMatches(
  token: Exclude<AttributePatternToken, { kind: "star" }>,
  character: string,
): boolean {
  return token.kind === "single" ? character !== "/" : character === token.value;
}

function generatedAttributeValue(attributes: readonly string[]): boolean | null {
  let value: boolean | null = null;
  for (const attribute of attributes) {
    if (attribute === "linguist-generated" || attribute === "linguist-generated=true") {
      value = true;
    } else if (
      attribute === "-linguist-generated"
      || attribute === "!linguist-generated"
      || attribute === "linguist-generated=false"
    ) {
      value = false;
    }
  }
  return value;
}

interface GeneratedAttributeState {
  remainingLines: number;
  generatedRules: number;
  generated: boolean;
}

function orderedGeneratedAttributeFiles(
  attributeFiles: readonly GithubGeneratedAttributeFile[],
): GithubGeneratedAttributeFile[] {
  return [...attributeFiles].sort((left, right) => {
    const leftDepth = left.directory ? left.directory.split("/").length : 0;
    const rightDepth = right.directory ? right.directory.split("/").length : 0;
    const depth = leftDepth - rightDepth;
    return depth !== 0 ? depth : left.directory.localeCompare(right.directory);
  });
}

function applyGeneratedAttributeFile(
  path: string,
  attributeFile: GithubGeneratedAttributeFile,
  state: GeneratedAttributeState,
): boolean {
  if (
    new TextEncoder().encode(attributeFile.text).byteLength > GIT_ATTRIBUTES_MAX_BYTES
    || attributeFile.directory.length > PULL_REQUEST_FILE_PATH_MAX_LENGTH
  ) return false;
  const relativePath = relativeAttributePath(path, attributeFile.directory);
  if (relativePath === null) return true;
  const lines = attributeFile.text.split(/\r?\n/);
  if (lines.length > state.remainingLines) return false;
  state.remainingLines -= lines.length;
  return applyGeneratedAttributeLines(relativePath, lines, state);
}

function applyGeneratedAttributeLines(
  path: string,
  lines: readonly string[],
  state: GeneratedAttributeState,
): boolean {
  for (const line of lines) {
    const rule = generatedAttributeRule(line);
    if (!rule) continue;
    if (state.generatedRules >= GIT_ATTRIBUTES_MAX_GENERATED_RULES) return false;
    state.generatedRules += 1;
    if (patternMatchesPath(rule.pattern, path)) state.generated = rule.value;
  }
  return true;
}

function generatedAttributeRule(line: string): { pattern: string; value: boolean } | null {
  if (line.length > GIT_ATTRIBUTES_MAX_LINE_LENGTH) return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const [pattern, ...attributes] = trimmed.split(/\s+/);
  const value = generatedAttributeValue(attributes);
  return value === null ? null : { pattern, value };
}

/** Resolve generated state only from bounded matching linguist-generated attributes. */
export function isGithubGeneratedPath(
  path: string,
  attributeFiles: readonly GithubGeneratedAttributeFile[],
): boolean {
  if (!validRemotePath(path)) return false;
  const state: GeneratedAttributeState = {
    generated: false,
    generatedRules: 0,
    remainingLines: GIT_ATTRIBUTES_MAX_LINES,
  };
  for (const attributeFile of orderedGeneratedAttributeFiles(attributeFiles)) {
    if (!applyGeneratedAttributeFile(path, attributeFile, state)) return false;
  }
  return state.generated;
}

function splitTextLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function parsedPatchLineCount(patch: string): number {
  if (patch.length === 0) return 0;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function boundedPatch(patch: string): { patch: string; parsedLineCount: number } | null {
  if (new TextEncoder().encode(patch).byteLength > PULL_REQUEST_PATCH_MAX_BYTES) return null;
  const lines = patch.split("\n");
  if (
    lines.some(
      (line) => Buffer.byteLength(line, "utf8") > PULL_REQUEST_PATCH_MAX_LINE_LENGTH,
    )
  ) return null;
  const parsedLineCount = parsedPatchLineCount(patch);
  return parsedLineCount <= PULL_REQUEST_PATCH_MAX_LINES ? { patch, parsedLineCount } : null;
}

function reconstructReplacementPatch(oldText: string, newText: string): string {
  if (oldText === newText) return "";
  const oldLines = splitTextLines(oldText);
  const newLines = splitTextLines(newText);
  const oldStart = oldLines.length === 0 ? 0 : 1;
  const newStart = newLines.length === 0 ? 0 : 1;
  return [
    `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

/** Bound a provider patch or reconstruct a full replacement from bounded blob text. */
export function normalizeGithubPullRequestPatch(
  evidence: GithubPullRequestPatchEvidence,
): GithubNormalizedPullRequestPatch {
  if (evidence.binary) return { status: "binary", patch: null, parsedLineCount: null };
  if (evidence.blobTooLarge) return { status: "too_large", patch: null, parsedLineCount: null };
  const candidate = evidence.patch ?? (
    evidence.oldText !== null && evidence.newText !== null
      ? reconstructReplacementPatch(evidence.oldText, evidence.newText)
      : null
  );
  if (candidate === null) return { status: "unavailable", patch: null, parsedLineCount: null };
  const bounded = boundedPatch(candidate);
  if (!bounded) return { status: "too_large", patch: null, parsedLineCount: null };
  return {
    status: evidence.generated ? "generated" : "available",
    patch: bounded.patch,
    parsedLineCount: bounded.parsedLineCount,
  };
}
