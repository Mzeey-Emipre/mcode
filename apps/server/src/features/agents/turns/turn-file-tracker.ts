import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import type { FileEffect, TurnFileEffectSummary } from "@mcode/contracts";
import { MAX_TURN_FILE_EFFECTS } from "@mcode/contracts";
import { normalizeFilesystemPath } from "../../../shared/filesystem/path-identity.js";

const MAX_FILE_BYTES = 1_048_576;
const MAX_EVIDENCE_TEXT_BYTES = 1_048_576;
const MAX_LINE_DIFF_WORK = 2_000_000;
const MAX_SYNC_OBSERVATION_PATHS = 4;
const MAX_SYNC_OBSERVATION_BYTES = 1_048_576;
const EMPTY_SUMMARY: TurnFileEffectSummary = {
  revision: 0,
  fileCount: 0,
  additions: 0,
  deletions: 0,
  effects: [],
};

type OperationHint = "add" | "edit" | "remove" | "rename";

interface MutationCandidate {
  path: string;
  operationHint: OperationHint;
  providerConfirmed?: boolean;
  oldPath?: string;
  beforeText?: string;
  afterText?: string;
}

interface CandidateObservation {
  resolvedPath: Pick<TrackedPath, "path" | "displayPath" | "scope"> | null;
  resolvedOldPath: Pick<TrackedPath, "path" | "displayPath" | "scope"> | null;
  baseline: FileState | null;
  oldBaseline: FileState | null;
}

interface SyncObservationBudget {
  remainingPaths: number;
  remainingBytes: number;
}

interface FileState {
  known: boolean;
  exists: boolean;
  hash: string | null;
  text: string | null;
  binary: boolean;
}

interface TrackedPath {
  path: string;
  displayPath: string;
  scope: "workspace" | "external";
  operationHint: OperationHint;
  oldPath?: string;
  oldResolvedPath?: string;
  oldBaseline?: FileState;
  oldCurrent?: FileState;
  baseline: FileState;
  current: FileState;
  effectCandidate?: EffectCandidate | null;
  providerConfirmed: boolean;
  toolCallIds: Set<string>;
}

interface TurnState {
  generation: number;
  cwd: string;
  canonicalRoot: string;
  baselineRef: string | null;
  revision: number;
  tracked: Map<string, TrackedPath>;
  summary: TurnFileEffectSummary;
  chain: Promise<void>;
}

/** Callback invoked after a verified net file-effect summary changes. */
export type FileEffectUpdateListener = (
  threadId: string,
  turnId: string,
  summary: TurnFileEffectSummary,
) => void;

/** Reads one UTF-8 file from the immutable pre-turn tree, or null when absent. */
export type TurnBaselineReader = (
  cwd: string,
  ref: string,
  relativePath: string,
) => Promise<{ kind: "text"; text: string } | { kind: "missing" } | { kind: "unavailable" }>;

/** Injection token for the composed live file-effect tracker. */
export const TURN_FILE_TRACKER = "TurnFileTracker";

/**
 * Tracks bounded, explicit agent file mutations and reduces them to net turn effects.
 * Git supplies the immutable in-project baseline; external paths use the state observed
 * when an explicit file tool starts or provider-supplied full before text.
 */
export class TurnFileTracker {
  private readonly turns = new Map<string, Map<number, TurnState>>();
  private readonly currentGeneration = new Map<string, number>();
  /** Origin generation for an explicit file tool, keyed by thread and provider call id. */
  private readonly generationByToolCall = new Map<string, number>();
  private nextGeneration = 1;

  constructor(
    private readonly readBaseline: TurnBaselineReader,
    private readonly onUpdate: FileEffectUpdateListener,
    private readonly platform: NodeJS.Platform,
  ) {}

  /** Start a fresh tracker scope for an agent turn. */
  beginTurn(threadId: string, cwd: string, baselineRef: string | null): number {
    const canonicalRoot = normalizeFilesystemPath(NodeFS.realpathSync.native(cwd), this.platform);
    const generation = this.nextGeneration++;
    const generations = this.turns.get(threadId) ?? new Map<number, TurnState>();
    generations.set(generation, {
      generation,
      cwd,
      canonicalRoot,
      baselineRef,
      revision: 0,
      tracked: new Map(),
      summary: EMPTY_SUMMARY,
      chain: Promise.resolve(),
    });
    while (generations.size > 4) {
      const oldest = generations.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      generations.delete(oldest);
    }
    this.turns.set(threadId, generations);
    this.currentGeneration.set(threadId, generation);
    return generation;
  }

  /** Return the authoritative tracker generation for the active turn. */
  getCurrentTurnId(threadId: string): string | undefined {
    const generation = this.currentGeneration.get(threadId);
    return generation === undefined ? undefined : String(generation);
  }

  /** Attach a Git baseline that completed after the turn tracker was initialized. */
  setBaselineRef(threadId: string, generation: number, baselineRef: string): Promise<void> {
    return this.enqueue(threadId, (turn) => this.applyBaselineRef(turn, threadId, baselineRef), generation);
  }

  /** Capture baselines for explicit file mutations named by a provider ToolUse event. */
  observeToolUse(
    threadId: string,
    toolCallId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<void> {
    const candidates = extractMutationCandidates(toolName, toolInput);
    if (candidates.length === 0) return Promise.resolve();
    const generation = this.currentGeneration.get(threadId);
    if (generation === undefined) return Promise.resolve();
    const turn = this.getTurn(threadId, generation);
    if (!turn) return Promise.resolve();
    const boundedCandidates = dedupeMutationCandidates(candidates).slice(0, MAX_TURN_FILE_EFFECTS);
    const observations = this.synchronousObservations(turn, boundedCandidates);
    this.generationByToolCall.set(toolGenerationKey(threadId, toolCallId), generation);
    return this.enqueue(threadId, async (queuedTurn) => {
      for (const [index, candidate] of boundedCandidates.entries()) {
        await this.captureCandidate(queuedTurn, toolCallId, candidate, observations[index]);
      }
    }, generation);
  }

  /** Verify all paths attributed to a completed file tool and publish the net summary. */
  observeToolResult(
    threadId: string,
    toolCallId: string,
    lateToolInput?: Record<string, unknown>,
  ): Promise<void> {
    const key = toolGenerationKey(threadId, toolCallId);
    const lateToolName = lateToolInput && typeof lateToolInput._mcodeToolName === "string"
      ? lateToolInput._mcodeToolName
      : "Edit";
    const lateCandidates = lateToolInput
      ? extractMutationCandidates(lateToolName, lateToolInput)
      : [];
    const generation = this.generationByToolCall.get(key)
      ?? (lateCandidates.length > 0 ? this.currentGeneration.get(threadId) : undefined);
    if (generation === undefined) return Promise.resolve();
    if (lateCandidates.length > 0) this.generationByToolCall.set(key, generation);
    const result = this.enqueue(threadId, async (turn) => {
      if (lateToolInput) {
        for (const candidate of lateCandidates.slice(0, MAX_TURN_FILE_EFFECTS)) {
          await this.captureCandidate(turn, toolCallId, candidate);
        }
      }
      await this.recompute(turn, threadId, toolCallId);
    }, generation);
    return result.finally(() => this.generationByToolCall.delete(key));
  }

  /** Return the latest net summary after all queued observations settle. */
  async finalizeTurn(threadId: string, generation?: number): Promise<TurnFileEffectSummary> {
    const turn = this.getTurn(threadId, generation);
    if (!turn) return EMPTY_SUMMARY;
    await turn.chain;
    return turn.summary;
  }

  /** Clear a completed turn after its summary has been persisted. */
  clearTurn(threadId: string, generation?: number): void {
    const target = generation ?? this.currentGeneration.get(threadId);
    if (target === undefined) return;
    const generations = this.turns.get(threadId);
    generations?.delete(target);
    if (generations?.size === 0) this.turns.delete(threadId);
    this.updateCurrentGeneration(threadId, target, generations);
    this.clearToolCallGenerations(threadId, target);
  }

  private enqueue(
    threadId: string,
    work: (turn: TurnState) => Promise<void>,
    generation?: number,
  ): Promise<void> {
    const turn = this.getTurn(threadId, generation);
    if (!turn) return Promise.resolve();
    const operation = turn.chain.then(() => work(turn));
    turn.chain = operation.catch(() => undefined);
    return operation;
  }

  private getTurn(threadId: string, generation?: number): TurnState | undefined {
    const target = generation ?? this.currentGeneration.get(threadId);
    return target === undefined ? undefined : this.turns.get(threadId)?.get(target);
  }

  private async applyBaselineRef(turn: TurnState, threadId: string, baselineRef: string): Promise<void> {
    if (turn.baselineRef !== null) return;
    turn.baselineRef = baselineRef;
    for (const tracked of turn.tracked.values()) {
      await this.refreshProviderConfirmedBaseline(turn, tracked);
    }
    this.publishSummary(turn, threadId);
  }

  private async refreshProviderConfirmedBaseline(turn: TurnState, tracked: TrackedPath): Promise<void> {
    if (!tracked.providerConfirmed || tracked.scope !== "workspace") return;
    const baseline = await this.readGitBaseline(turn, tracked.displayPath);
    if (baseline && (baseline.known || !tracked.baseline.known)) tracked.baseline = baseline;
    if (tracked.oldPath && tracked.oldResolvedPath) {
      const oldBaseline = await this.readGitBaseline(turn, tracked.oldPath);
      if (oldBaseline) tracked.oldBaseline = oldBaseline;
      tracked.oldCurrent = await readBoundedState(tracked.oldResolvedPath);
    }
    tracked.current = await readBoundedState(tracked.path);
    tracked.effectCandidate = buildEffect(tracked);
  }

  private synchronousObservations(
    turn: TurnState,
    candidates: readonly MutationCandidate[],
  ): Array<CandidateObservation | undefined> {
    const budget: SyncObservationBudget = {
      remainingPaths: MAX_SYNC_OBSERVATION_PATHS,
      remainingBytes: MAX_SYNC_OBSERVATION_BYTES,
    };
    return candidates.map((candidate) => this.synchronousObservation(turn.canonicalRoot, candidate, budget));
  }

  private synchronousObservation(
    canonicalRoot: string,
    candidate: MutationCandidate,
    budget: SyncObservationBudget,
  ): CandidateObservation | undefined {
    const requiredPaths = candidate.operationHint === "rename" && candidate.oldPath ? 2 : 1;
    if (candidate.beforeText !== undefined || budget.remainingPaths < requiredPaths) return undefined;
    return observeCandidateSynchronously(canonicalRoot, candidate, budget, this.platform);
  }

  private updateCurrentGeneration(
    threadId: string,
    target: number,
    generations: Map<number, TurnState> | undefined,
  ): void {
    if (this.currentGeneration.get(threadId) !== target) return;
    const latest = generations && generations.size > 0 ? [...generations.keys()].at(-1) : undefined;
    if (latest === undefined) this.currentGeneration.delete(threadId);
    else this.currentGeneration.set(threadId, latest);
  }

  private clearToolCallGenerations(threadId: string, target: number): void {
    for (const [key, origin] of this.generationByToolCall) {
      if (origin === target && key.startsWith(`${threadId}\0`)) this.generationByToolCall.delete(key);
    }
  }

  private async captureCandidate(
    turn: TurnState,
    toolCallId: string,
    candidate: MutationCandidate,
    observation?: CandidateObservation,
  ): Promise<void> {
    if (turn.tracked.size >= MAX_TURN_FILE_EFFECTS) return;
    const paths = await this.candidatePaths(turn, candidate, observation);
    if (!paths) return;
    const existing = turn.tracked.get(paths.resolvedPath.path);
    if (existing) return this.updateTrackedCandidate(turn, existing, toolCallId, candidate, observation, paths.validOldPath);
    await this.trackCandidate(turn, toolCallId, candidate, observation, paths.resolvedPath, paths.validOldPath);
  }

  private async candidatePaths(
    turn: TurnState,
    candidate: MutationCandidate,
    observation: CandidateObservation | undefined,
  ): Promise<{
    resolvedPath: Pick<TrackedPath, "path" | "displayPath" | "scope">;
    validOldPath: Pick<TrackedPath, "path" | "displayPath" | "scope"> | null;
  } | null> {
    const resolvedPath = observation
      ? observation.resolvedPath
      : await resolveCandidatePath(turn.canonicalRoot, candidate.path, this.platform);
    if (!resolvedPath) return null;
    const resolvedOldPath = await this.oldCandidatePath(turn, candidate, observation);
    return {
      resolvedPath,
      validOldPath: resolvedOldPath?.path === resolvedPath.path ? null : resolvedOldPath,
    };
  }

  private async oldCandidatePath(
    turn: TurnState,
    candidate: MutationCandidate,
    observation: CandidateObservation | undefined,
  ): Promise<Pick<TrackedPath, "path" | "displayPath" | "scope"> | null> {
    if (candidate.operationHint !== "rename" || !candidate.oldPath) return null;
    return observation
      ? observation.resolvedOldPath
      : resolveCandidatePath(turn.canonicalRoot, candidate.oldPath, this.platform);
  }

  private async updateTrackedCandidate(
    turn: TurnState,
    existing: TrackedPath,
    toolCallId: string,
    candidate: MutationCandidate,
    observation: CandidateObservation | undefined,
    validOldPath: Pick<TrackedPath, "path" | "displayPath" | "scope"> | null,
  ): Promise<void> {
    existing.toolCallIds.add(toolCallId);
    existing.providerConfirmed ||= candidate.providerConfirmed === true;
    existing.effectCandidate = undefined;
    if (existing.operationHint !== "rename" || candidate.operationHint === "rename") {
      existing.operationHint = candidate.operationHint;
    }
    if (!validOldPath) return;
    const oldBaseline = await this.candidateBaseline(
      turn, validOldPath, "remove", candidate, observation?.oldBaseline, true,
    );
    existing.oldPath = validOldPath.displayPath;
    existing.oldResolvedPath = validOldPath.path;
    existing.oldBaseline = oldBaseline;
    existing.oldCurrent = oldBaseline;
  }

  private async trackCandidate(
    turn: TurnState,
    toolCallId: string,
    candidate: MutationCandidate,
    observation: CandidateObservation | undefined,
    resolvedPath: Pick<TrackedPath, "path" | "displayPath" | "scope">,
    validOldPath: Pick<TrackedPath, "path" | "displayPath" | "scope"> | null,
  ): Promise<void> {
    const baseline = await this.candidateBaseline(
      turn, resolvedPath, candidate.operationHint, candidate, observation?.baseline, !validOldPath,
    );
    const oldBaseline = validOldPath
      ? await this.candidateBaseline(turn, validOldPath, "remove", candidate, observation?.oldBaseline, true)
      : undefined;
    turn.tracked.set(resolvedPath.path, {
      ...resolvedPath,
      operationHint: candidate.operationHint,
      ...(validOldPath ? {
        oldPath: validOldPath.displayPath,
        oldResolvedPath: validOldPath.path,
        oldBaseline,
        oldCurrent: oldBaseline,
      } : {}),
      baseline,
      current: baseline,
      providerConfirmed: candidate.providerConfirmed === true,
      toolCallIds: new Set([toolCallId]),
    });
  }

  private async candidateBaseline(
    turn: TurnState,
    resolvedPath: Pick<TrackedPath, "path" | "displayPath" | "scope">,
    operationHint: OperationHint,
    candidate: MutationCandidate,
    observedBaseline: FileState | null | undefined,
    acceptsEvidence: boolean,
  ): Promise<FileState> {
    if (acceptsEvidence && candidate.beforeText !== undefined) return stateFromEvidenceText(candidate.beforeText);
    if (candidate.providerConfirmed === true) {
      return this.readProviderConfirmedBaseline(turn, resolvedPath, operationHint, observedBaseline ?? undefined);
    }
    return observedBaseline ?? readBoundedState(resolvedPath.path);
  }

  private async readProviderConfirmedBaseline(
    turn: TurnState,
    resolvedPath: Pick<TrackedPath, "path" | "displayPath" | "scope">,
    operationHint: OperationHint,
    observedBaseline?: FileState,
  ): Promise<FileState> {
    if (resolvedPath.scope === "workspace" && turn.baselineRef) {
      const baseline = await this.readGitBaseline(turn, resolvedPath.displayPath);
      if (baseline?.known) return baseline;
    }
    return observedBaseline ?? inferredProviderBaseline(operationHint);
  }

  private async readGitBaseline(turn: TurnState, relativePath: string): Promise<FileState | null> {
    if (!turn.baselineRef || !relativePath || relativePath.startsWith("..")) return null;
    try {
      const baseline = await this.readBaseline(turn.cwd, turn.baselineRef, relativePath);
      if (baseline.kind === "missing") {
        return missingState();
      }
      if (baseline.kind === "unavailable") {
        return unknownExistingState();
      }
      return stateFromEvidenceText(baseline.text);
    } catch {
      return unknownExistingState();
    }
  }

  private async recompute(turn: TurnState, threadId: string, toolCallId: string): Promise<void> {
    for (const tracked of turn.tracked.values()) {
      if (!tracked.toolCallIds.has(toolCallId)) continue;
      tracked.current = await readBoundedState(tracked.path);
      if (tracked.oldResolvedPath) {
        tracked.oldCurrent = await readBoundedState(tracked.oldResolvedPath);
      }
      tracked.effectCandidate = buildEffect(tracked);
    }
    this.publishSummary(turn, threadId);
  }

  private publishSummary(turn: TurnState, threadId: string): void {
    const candidates = [...turn.tracked.values()].flatMap((tracked) => (
      tracked.effectCandidate ? [tracked.effectCandidate] : []
    ));
    const effects = collapseHashMatchedRenames(candidates);
    effects.sort((a, b) => a.path.localeCompare(b.path));
    const additions = effects.reduce((total, effect) => total + (effect.additions ?? 0), 0);
    const deletions = effects.reduce((total, effect) => total + (effect.deletions ?? 0), 0);
    const comparable = { fileCount: effects.length, additions, deletions, effects };
    if (JSON.stringify(comparable) === JSON.stringify({
      fileCount: turn.summary.fileCount,
      additions: turn.summary.additions,
      deletions: turn.summary.deletions,
      effects: turn.summary.effects,
    })) return;
    turn.revision += 1;
    turn.summary = { revision: turn.revision, ...comparable };
    this.onUpdate(threadId, String(turn.generation), turn.summary);
  }
}

function toolGenerationKey(threadId: string, toolCallId: string): string {
  return `${threadId}\0${toolCallId}`;
}

function extractMutationCandidates(
  toolName: string,
  input: Record<string, unknown>,
): MutationCandidate[] {
  const mcodeCandidates = extractMcodeMutationCandidates(input);
  if (mcodeCandidates) return mcodeCandidates;
  const fileChangeCandidates = extractFileChangeCandidates(toolName, input);
  if (fileChangeCandidates) return fileChangeCandidates;
  return extractExplicitToolMutationCandidate(toolName, input);
}

function extractMcodeMutationCandidates(input: Record<string, unknown>): MutationCandidate[] | undefined {
  if (!Array.isArray(input._mcodeFileMutations)) return undefined;
  return collectMutationCandidates(input._mcodeFileMutations, mcodeMutationCandidate);
}

function extractFileChangeCandidates(
  toolName: string,
  input: Record<string, unknown>,
): MutationCandidate[] | undefined {
  const normalized = toolName.toLowerCase();
  if (normalized !== "file_change" || !Array.isArray(input.changes)) return undefined;
  return collectMutationCandidates(input.changes, fileChangeMutationCandidate);
}

function extractExplicitToolMutationCandidate(
  toolName: string,
  input: Record<string, unknown>,
): MutationCandidate[] {
  const normalized = toolName.toLowerCase();
  if (!isExplicitFileTool(normalized)) return [];
  const path = pickString(input, normalized === "rename" || normalized === "move"
    ? [
        "newPath", "new_path", "destinationPath", "destination_path", "destination", "to",
        "file_path", "filePath", "path", "target_file", "targetFile",
      ]
    : ["file_path", "filePath", "path", "target_file", "targetFile"]);
  if (!path) return [];
  const oldPath = pickString(input, [
    "oldPath", "old_path", "old_file_path", "oldFilePath", "sourcePath", "source_path", "from",
  ]);
  return [{
    path,
    operationHint: normalizeOperation(input.operation ?? input.kind ?? toolName),
    ...(oldPath ? { oldPath } : {}),
  }];
}

function collectMutationCandidates(
  values: readonly unknown[],
  candidateFor: (value: unknown) => MutationCandidate | null,
): MutationCandidate[] {
  const candidates: MutationCandidate[] = [];
  const seenPaths = new Set<string>();
  for (const value of values) {
    if (candidates.length >= MAX_TURN_FILE_EFFECTS) break;
    const candidate = candidateFor(value);
    if (!candidate) continue;
    const identity = `${candidate.path}\0${candidate.oldPath ?? ""}`;
    if (seenPaths.has(identity)) continue;
    seenPaths.add(identity);
    candidates.push(candidate);
  }
  return candidates;
}

function mcodeMutationCandidate(value: unknown): MutationCandidate | null {
  const mutation = mutationRecord(value);
  if (!mutation) return null;
  const beforeText = fullFileEvidenceText(mutation, "beforeText");
  const afterText = fullFileEvidenceText(mutation, "afterText");
  const oldPath = pickString(mutation, ["oldPath", "old_path", "sourcePath", "source_path", "from"]);
  return {
    path: mutation.path as string,
    operationHint: normalizeOperation(mutation.kind ?? mutation.operation),
    ...(oldPath ? { oldPath } : {}),
    ...(beforeText !== undefined ? { beforeText } : {}),
    ...(afterText !== undefined ? { afterText } : {}),
  };
}

function fileChangeMutationCandidate(value: unknown): MutationCandidate | null {
  const change = mutationRecord(value);
  if (!change) return null;
  const oldPath = pickString(change, ["oldPath", "old_path", "sourcePath", "source_path", "from"]);
  return {
    path: change.path as string,
    operationHint: normalizeOperation(change.kind ?? change.operation),
    providerConfirmed: true,
    ...(oldPath ? { oldPath } : {}),
  };
}

function mutationRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.path === "string" ? record : null;
}

function fullFileEvidenceText(record: Record<string, unknown>, key: "beforeText" | "afterText"): string | undefined {
  return record.fullFileContent === true && typeof record[key] === "string"
    ? boundedEvidenceText(record[key])
    : undefined;
}

function isExplicitFileTool(name: string): boolean {
  return [
    "edit", "write", "delete", "remove", "create", "rename", "move",
    "apply_patch", "strreplace", "searchreplace",
  ].includes(name);
}

function normalizeOperation(value: unknown): OperationHint {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("delete") || text.includes("remove")) return "remove";
  if (text.includes("rename") || text.includes("move")) return "rename";
  if (text.includes("add") || text.includes("create") || text.includes("write")) return "add";
  return "edit";
}

function pickString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function boundedEvidenceText(value: string | undefined): string | undefined {
  if (value === undefined || Buffer.byteLength(value, "utf8") > MAX_EVIDENCE_TEXT_BYTES) return undefined;
  return value;
}

function dedupeMutationCandidates(candidates: MutationCandidate[]): MutationCandidate[] {
  const unique = new Map<string, MutationCandidate>();
  for (const candidate of candidates) {
    const identity = `${candidate.path}\0${candidate.oldPath ?? ""}`;
    if (!unique.has(identity)) unique.set(identity, candidate);
  }
  return [...unique.values()];
}

function observeCandidateSynchronously(
  canonicalRoot: string,
  candidate: MutationCandidate,
  budget: SyncObservationBudget,
  platform: NodeJS.Platform,
): CandidateObservation {
  const resolvedPath = observePathSynchronously(canonicalRoot, candidate.path, budget, platform);
  const resolvedOldPath = observeRenameSourceSynchronously(canonicalRoot, candidate, budget, platform);
  return {
    resolvedPath: resolvedPath?.path ?? null,
    resolvedOldPath: resolvedOldPath?.path ?? null,
    baseline: resolvedPath?.baseline ?? null,
    oldBaseline: resolvedOldPath?.baseline ?? null,
  };
}

function observeRenameSourceSynchronously(
  canonicalRoot: string,
  candidate: MutationCandidate,
  budget: SyncObservationBudget,
  platform: NodeJS.Platform,
): ReturnType<typeof observePathSynchronously> {
  if (candidate.operationHint !== "rename" || !candidate.oldPath) return null;
  return observePathSynchronously(canonicalRoot, candidate.oldPath, budget, platform);
}

function observePathSynchronously(
  canonicalRoot: string,
  candidatePath: string,
  budget: SyncObservationBudget,
  platform: NodeJS.Platform,
): {
  path: Pick<TrackedPath, "path" | "displayPath" | "scope">;
  baseline: FileState;
} | null {
  if (budget.remainingPaths === 0) return null;
  budget.remainingPaths -= 1;
  const path = resolveCandidatePathSynchronously(canonicalRoot, candidatePath, platform);
  return path ? { path, baseline: readBoundedStateSynchronously(path.path, budget) } : null;
}

function resolveCandidatePathSynchronously(
  canonicalRoot: string,
  candidatePath: string,
  platform: NodeJS.Platform,
): Pick<TrackedPath, "path" | "displayPath" | "scope"> | null {
  if (candidatePath.length === 0 || candidatePath.length > 4096 || candidatePath.includes("\0")) return null;
  const absolute = NodePath.resolve(canonicalRoot, candidatePath);
  const canonical = canonicalizePotentialPathSynchronously(absolute, platform);
  if (!canonical) return null;
  const relativePath = NodePath.relative(canonicalRoot, canonical);
  const scope = relativePath === "" || (!relativePath.startsWith(`..${NodePath.sep}`) && relativePath !== ".." && !NodePath.isAbsolute(relativePath))
    ? "workspace"
    : "external";
  return {
    path: canonical,
    displayPath: scope === "workspace" ? relativePath : absolute,
    scope,
  };
}

function canonicalizePotentialPathSynchronously(
  absolutePath: string,
  platform: NodeJS.Platform,
): string | null {
  let cursor = absolutePath;
  const missing: string[] = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const existing = NodeFS.realpathSync.native(cursor);
      return normalizeFilesystemPath(NodePath.resolve(existing, ...missing), platform);
    } catch {
      const parent = NodePath.dirname(cursor);
      if (parent === cursor) return null;
      missing.unshift(NodePath.basename(cursor));
      cursor = parent;
    }
  }
  return null;
}

async function resolveCandidatePath(
  canonicalRoot: string,
  candidatePath: string,
  platform: NodeJS.Platform,
): Promise<Pick<TrackedPath, "path" | "displayPath" | "scope"> | null> {
  if (candidatePath.length === 0 || candidatePath.length > 4096 || candidatePath.includes("\0")) return null;
  const absolute = NodePath.resolve(canonicalRoot, candidatePath);
  const canonical = await canonicalizePotentialPath(absolute, platform);
  if (!canonical) return null;
  const relativePath = NodePath.relative(canonicalRoot, canonical);
  const scope = relativePath === "" || (!relativePath.startsWith(`..${NodePath.sep}`) && relativePath !== ".." && !NodePath.isAbsolute(relativePath))
    ? "workspace"
    : "external";
  return {
    path: canonical,
    displayPath: scope === "workspace" ? relativePath : absolute,
    scope,
  };
}

async function canonicalizePotentialPath(
  absolutePath: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  let cursor = absolutePath;
  const missing: string[] = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const existing = await NodeFSPromises.realpath(cursor);
      return normalizeFilesystemPath(NodePath.resolve(existing, ...missing), platform);
    } catch {
      const parent = NodePath.dirname(cursor);
      if (parent === cursor) return null;
      missing.unshift(NodePath.basename(cursor));
      cursor = parent;
    }
  }
  return null;
}

async function readBoundedState(path: string): Promise<FileState> {
  try {
    const stat = await NodeFSPromises.lstat(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return unknownExistingState();
    }
    const bytes = await NodeFSPromises.readFile(path);
    const binary = bytes.includes(0);
    return {
      known: true,
      exists: true,
      hash: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      text: binary ? null : bytes.toString("utf8"),
      binary,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? missingState()
      : unknownExistingState();
  }
}

function readBoundedStateSynchronously(path: string, budget: SyncObservationBudget): FileState {
  try {
    const stat = NodeFS.lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size > budget.remainingBytes) {
      return unknownExistingState();
    }
    budget.remainingBytes -= stat.size;
    const bytes = NodeFS.readFileSync(path);
    const binary = bytes.includes(0);
    return {
      known: true,
      exists: true,
      hash: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      text: binary ? null : bytes.toString("utf8"),
      binary,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? missingState()
      : unknownExistingState();
  }
}

function stateFromEvidenceText(text: string): FileState {
  const bytes = Buffer.from(text, "utf8");
  return {
    known: true,
    exists: true,
    hash: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    text,
    binary: false,
  };
}

function missingState(): FileState {
  return { known: true, exists: false, hash: null, text: null, binary: false };
}

function unknownExistingState(): FileState {
  return { known: false, exists: true, hash: null, text: null, binary: true };
}

function inferredProviderBaseline(operationHint: OperationHint): FileState {
  return operationHint === "add" ? missingState() : unknownExistingState();
}

interface EffectCandidate {
  effect: FileEffect;
  beforeHash: string | null;
  afterHash: string | null;
}

function buildEffect(tracked: TrackedPath): EffectCandidate | null {
  const after = tracked.current;
  const isValidatedRename = validatedRename(tracked);
  if (!tracked.baseline.known || !after.known) return providerConfirmedEffect(tracked, after, null);
  if (!isValidatedRename && unchangedFileState(tracked.baseline, after)) {
    return providerConfirmedEffect(tracked, after, tracked.baseline.hash);
  }
  const kind = observedEffectKind(tracked, after, isValidatedRename);
  const before = isValidatedRename ? tracked.oldBaseline! : tracked.baseline;
  const stats = lineStats(
    before.exists ? before.text : "",
    after.exists ? after.text : "",
  );
  return effectCandidate(tracked, before, after, kind, stats, before.hash);
}

function validatedRename(tracked: TrackedPath): boolean {
  if (tracked.operationHint !== "rename" || !tracked.oldPath) return false;
  return sourceWasRemoved(tracked) && destinationWasAdded(tracked);
}

function sourceWasRemoved(tracked: TrackedPath): boolean {
  return tracked.oldBaseline?.known === true
    && tracked.oldCurrent?.known === true
    && tracked.oldBaseline.exists
    && !tracked.oldCurrent.exists;
}

function destinationWasAdded(tracked: TrackedPath): boolean {
  return tracked.baseline.known && tracked.current.known && !tracked.baseline.exists && tracked.current.exists;
}

function unchangedFileState(before: FileState, after: FileState): boolean {
  return before.exists === after.exists && before.hash === after.hash;
}

function providerConfirmedEffect(
  tracked: TrackedPath,
  after: FileState,
  beforeHash: string | null,
): EffectCandidate | null {
  const kind = providerConfirmedEffectKind(tracked, after);
  if (!kind) return null;
  return effectCandidate(tracked, tracked.baseline, after, kind, null, beforeHash);
}

function providerConfirmedEffectKind(tracked: TrackedPath, after: FileState): FileEffect["kind"] | null {
  if (!tracked.providerConfirmed) return null;
  if (tracked.operationHint === "remove" && after.known && !after.exists) return "removed";
  if (tracked.operationHint === "add" && after.exists) return "added";
  return tracked.operationHint === "edit" && after.exists ? "edited" : null;
}

function observedEffectKind(
  tracked: TrackedPath,
  after: FileState,
  isValidatedRename: boolean,
): FileEffect["kind"] {
  if (isValidatedRename) return "renamed";
  if (!tracked.baseline.exists && after.exists) return "added";
  return tracked.baseline.exists && !after.exists ? "removed" : "edited";
}

function effectCandidate(
  tracked: TrackedPath,
  before: FileState,
  after: FileState,
  kind: FileEffect["kind"],
  stats: { additions: number; deletions: number } | null,
  beforeHash: string | null,
): EffectCandidate {
  return {
    effect: fileEffect(tracked, before, after, kind, stats),
    beforeHash,
    afterHash: after.hash,
  };
}

function fileEffect(
  tracked: TrackedPath,
  before: FileState,
  after: FileState,
  kind: FileEffect["kind"],
  stats: { additions: number; deletions: number } | null,
): FileEffect {
  return {
    path: tracked.displayPath,
    kind,
    scope: tracked.scope,
    ...(kind === "renamed" && tracked.oldPath ? { oldPath: tracked.oldPath } : {}),
    additions: stats?.additions ?? null,
    deletions: stats?.deletions ?? null,
    binary: before.binary || after.binary,
    toolCallIds: [...tracked.toolCallIds].slice(0, 32),
  };
}

function collapseHashMatchedRenames(candidates: EffectCandidate[]): FileEffect[] {
  const removedByHash = removedCandidatesByHash(candidates);
  const { consumed, effects } = renamedEffects(candidates, removedByHash);
  return [...effects, ...unconsumedEffects(candidates, consumed)];
}

function removedCandidatesByHash(candidates: readonly EffectCandidate[]): Map<string, EffectCandidate[]> {
  const removedByHash = new Map<string, EffectCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.effect.kind !== "removed" || !candidate.beforeHash) continue;
    const matches = removedByHash.get(candidate.beforeHash) ?? [];
    matches.push(candidate);
    removedByHash.set(candidate.beforeHash, matches);
  }
  return removedByHash;
}

function renamedEffects(
  candidates: readonly EffectCandidate[],
  removedByHash: Map<string, EffectCandidate[]>,
): { consumed: Set<EffectCandidate>; effects: FileEffect[] } {
  const consumed = new Set<EffectCandidate>();
  const effects: FileEffect[] = [];
  for (const candidate of candidates) {
    if (candidate.effect.kind !== "added" || !candidate.afterHash) continue;
    const source = removedByHash.get(candidate.afterHash)?.shift();
    if (!source) continue;
    consumed.add(source);
    consumed.add(candidate);
    effects.push({
      ...candidate.effect,
      kind: "renamed",
      oldPath: source.effect.path,
      additions: 0,
      deletions: 0,
      binary: source.effect.binary || candidate.effect.binary,
      toolCallIds: [...new Set([
        ...source.effect.toolCallIds,
        ...candidate.effect.toolCallIds,
      ])].slice(0, 32),
    });
  }
  return { consumed, effects };
}

function unconsumedEffects(candidates: readonly EffectCandidate[], consumed: Set<EffectCandidate>): FileEffect[] {
  const effects: FileEffect[] = [];
  for (const candidate of candidates) {
    if (!consumed.has(candidate)) effects.push(candidate.effect);
  }
  return effects;
}

function lineStats(before: string | null, after: string | null): { additions: number; deletions: number } | null {
  if (before === null || after === null) return null;
  const left = tokenizeLines(before);
  const right = tokenizeLines(after);
  if (left.length * right.length > MAX_LINE_DIFF_WORK) return null;
  let previous = new Uint32Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Uint32Array(right.length + 1);
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1]! + 1
        : Math.max(previous[j]!, current[j - 1]!);
    }
    previous = current;
  }
  const common = previous[right.length] ?? 0;
  return { additions: right.length - common, deletions: left.length - common };
}

function tokenizeLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
