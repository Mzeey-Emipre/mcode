import * as NodeCrypto from "node:crypto";
import type { ProviderTurnDiffUpdate, ReviewComparison, TurnFileEffectSummary, TurnOutcome } from "@mcode/contracts";
import { parseTurnDiff, type ParsedTurnDiff } from "./turn-diff-patch.js";
import type { TurnDiffRepo, StoredTurnDiff } from "./persistence/turn-diff-repo.js";

export { TURN_DIFF_MAX_BYTES, TURN_DIFF_MAX_LINES, TURN_DIFF_MAX_LINE_BYTES } from "./turn-diff-patch.js";

/** Result of admitting native evidence for a dispatched turn. */
export type TurnDiffPushResult = "accepted" | "invalidated" | "stale";

type TurnDiffIdentity = Pick<ProviderTurnDiffUpdate, "turnId" | "turnExecutionId" | "deliveryAttempt">;
interface ActiveDiff extends TurnDiffIdentity {
  threadId: string;
  revision: number;
  evidence: ProviderTurnDiffUpdate | null;
  parsed: ParsedTurnDiff | null;
  rejected?: boolean;
}

/** Owns admission, volatile native evidence, and final source reconciliation. */
export class TurnDiffService {
  private readonly active = new Map<string, ActiveDiff>();

  constructor(private readonly repo: TurnDiffRepo, private readonly changed: (threadId: string) => void = () => {}) {}

  /** Admit the exact identity before dispatch, including retries. */
  begin(identity: TurnDiffIdentity & { threadId: string }): void {
    for (const [turnId, current] of this.active) {
      if (current.threadId === identity.threadId) this.active.delete(turnId);
    }
    this.active.set(identity.turnId, { threadId: identity.threadId, turnId: identity.turnId,
      turnExecutionId: identity.turnExecutionId, deliveryAttempt: identity.deliveryAttempt,
      revision: -1, evidence: null, parsed: null });
    this.changed(identity.threadId);
  }

  /** Replace a full aggregate only for the admitted attempt and a newer revision. */
  push(update: ProviderTurnDiffUpdate): TurnDiffPushResult {
    const current = this.active.get(update.turnId);
    if (!current || !isNewRevision(update, current)) return "stale";
    const parsed = update.state === "snapshot" ? parseTurnDiff(update.patch) : null;
    const evidence: ProviderTurnDiffUpdate = update.state === "snapshot" && !parsed
      ? { turnId: update.turnId, turnExecutionId: update.turnExecutionId, deliveryAttempt: update.deliveryAttempt, revision: update.revision, state: "invalidated" } : update;
    this.active.set(update.turnId, { ...current, revision: update.revision, evidence, parsed, rejected: update.state === "snapshot" && !parsed });
    this.changed(current.threadId);
    return evidence.state === "invalidated" ? "invalidated" : "accepted";
  }

  /** Drop volatile evidence only when its execution owns the terminal event. */
  clear(turnId: string, turnExecutionId?: string): void {
    const current = this.active.get(turnId);
    if (current && (!turnExecutionId || current.turnExecutionId === turnExecutionId)) {
      this.active.delete(turnId);
      this.changed(current.threadId);
    }
  }

  /** Freeze native evidence at the terminal fence before asynchronous file settlement. */
  prepareFinalization(threadId: string, executionId: string | undefined, outcome: TurnOutcome): SettleTurnDiff {
    const current = [...this.active.values()].find((entry) => entry.threadId === threadId && entry.turnExecutionId === executionId);
    if (!current) return () => {};
    this.clear(current.turnId, executionId);
    return (messageId, effects) => {
      if (outcome !== "completed") return;
      const selected = selectSettledEvidence(current, effects);
      if (!selected) return;
      this.repo.create({ id: NodeCrypto.randomUUID(), message_id: messageId, thread_id: threadId,
        ...selected, revision: Math.max(0, current.revision) });
      this.changed(threadId);
    };
  }

  /** Read current Live metadata; native patch bytes stay on the file-diff endpoint. */
  liveComparison(threadId: string): ReviewComparison | null {
    const current = [...this.active.values()].find((entry) => entry.threadId === threadId);
    if (!current?.parsed) return null;
    const { files, additions, deletions } = current.parsed;
    return { files, additions, deletions, turnDiff: { id: liveId(current), phase: "live", source: "native", fidelity: "agent", revision: current.revision } };
  }

  /** Read one native Live file only while that exact revision remains active. */
  liveFileDiff(threadId: string, id: string, path: string): string | undefined {
    const current = [...this.active.values()].find((entry) => entry.threadId === threadId && liveId(entry) === id);
    return current?.parsed?.filePatches.get(path);
  }

  /** Read durable source selection independently of a provider session. */
  latest(threadId: string): StoredTurnDiff | undefined { return this.repo.latest(threadId); }

  /** Drop only the volatile evidence owned by a lost provider execution. */
  clearExecution(threadId: string, executionId: string): void {
    const current = [...this.active.values()].find((entry) => entry.threadId === threadId && entry.turnExecutionId === executionId);
    if (current) this.clear(current.turnId, executionId);
  }

  /** Find the last completed legacy snapshot without rewriting historical rows. */
  latestLegacySnapshotId(threadId: string): string | undefined { return this.repo.latestLegacySnapshotId(threadId); }

  /** Read durable evidence only within its owning thread. */
  find(threadId: string, id: string): StoredTurnDiff | undefined { return this.repo.find(threadId, id); }
}

/** Persists a frozen terminal candidate after the assistant message and file effects exist. */
export type SettleTurnDiff = (messageId: string, effects: TurnFileEffectSummary | undefined) => void;

function liveId(current: ActiveDiff): string {
  return `live:${current.turnId}:${current.turnExecutionId}:${current.deliveryAttempt}:${current.revision}`;
}

function matches(identity: TurnDiffIdentity, active: TurnDiffIdentity): boolean {
  return identity.turnId === active.turnId && identity.turnExecutionId === active.turnExecutionId
    && identity.deliveryAttempt === active.deliveryAttempt;
}

function isNewRevision(update: ProviderTurnDiffUpdate, current: ActiveDiff): boolean {
  return matches(update, current) && Number.isSafeInteger(update.revision) && update.revision > current.revision;
}

function selectSettledEvidence(current: ActiveDiff, effects: TurnFileEffectSummary | undefined): Pick<StoredTurnDiff, "source" | "patch"> | null {
  const evidence = current.evidence;
  if (evidence) {
    if (evidence.state === "snapshot") return { source: "native", patch: evidence.patch };
    if (evidence.state === "invalidated" && !current.rejected) return null;
    if (evidence.state === "indeterminate-empty" && effects?.fileCount === 0) return { source: "native", patch: "" };
  }
  return effects?.fileCount ? { source: "git", patch: null } : null;
}
