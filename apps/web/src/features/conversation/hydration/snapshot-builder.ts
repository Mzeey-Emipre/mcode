import type { Message } from "@/transport";
import type { TurnSnapshot } from "@mcode/contracts";
import type { ThreadRecord } from "@/stores/thread-record";

/** Raw RPC inputs used to assemble a canonical thread-record patch. */
export interface SnapshotBuilderInput {
  messages: Message[];
  sessionNotices?: Message[];
  hasMore: boolean;
  answeredPlanMessageIds?: string[];
  snapshots?: TurnSnapshot[];
}

/** Derived file-change fields from turn snapshot rows. */
export interface FileChangeFields {
  persistedFilesChanged: Record<string, string[]>;
  latestTurnWithChanges: string | null;
  fileEffectSummary: ThreadRecord["fileEffectSummary"];
}

/**
 * The slice of {@link ThreadRecord} fields owned by the snapshot builder.
 * The builder is pure: no IO, no store writes. Hydrator commits this patch.
 */
export type ThreadRecordPatch = Pick<
  ThreadRecord,
  | "messages"
  | "sessionNotices"
  | "oldestLoadedSequence"
  | "newestLoadedSequence"
  | "hasMoreMessages"
  | "hasNewerMessages"
  | "persistedToolCallCounts"
  | "persistedFilesChanged"
  | "latestTurnWithChanges"
  | "fileEffectSummary"
  | "answeredPlanMessageIds"
>;

/**
 * Pure builder for the message-load slice of a {@link ThreadRecord}.
 * No IO — rollup of tool-call counts, file-change map, and pagination cursors.
 */
export class SnapshotBuilder {
  /**
   * Build a {@link ThreadRecordPatch} from message and snapshot RPC results.
   */
  build(input: SnapshotBuilderInput): ThreadRecordPatch {
    const { messages, hasMore, answeredPlanMessageIds, snapshots = [] } = input;

    const persistedToolCallCounts: Record<string, number> = {};
    for (const msg of messages) {
      if (msg.tool_call_count && msg.tool_call_count > 0) {
        persistedToolCallCounts[msg.id] = msg.tool_call_count;
      }
    }

    const oldestLoadedSequence = messages.length > 0 ? messages[0].sequence : 0;
    const newestLoadedSequence = messages.at(-1)?.sequence ?? 0;
    const fileChanges = SnapshotBuilder.deriveFileChanges(snapshots);

    return {
      messages,
      sessionNotices: input.sessionNotices ?? [],
      oldestLoadedSequence,
      newestLoadedSequence,
      hasMoreMessages: hasMore,
      hasNewerMessages: false,
      persistedToolCallCounts,
      persistedFilesChanged: fileChanges.persistedFilesChanged,
      latestTurnWithChanges: fileChanges.latestTurnWithChanges,
      fileEffectSummary: fileChanges.fileEffectSummary,
      answeredPlanMessageIds: new Set(answeredPlanMessageIds ?? []),
    };
  }

  /**
   * Derive the file-change map and latest-turn pointer from snapshot rows.
   * Snapshots arrive sorted by created_at ASC, so the last match wins.
   */
  static deriveFileChanges(snapshots: TurnSnapshot[]): FileChangeFields {
    const persistedFilesChanged: Record<string, string[]> = {};
    let latestTurnWithChanges: string | null = null;
    let fileEffectSummary: ThreadRecord["fileEffectSummary"] = {
      revision: 0,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      effects: [],
    };

    for (const snap of snapshots) {
      if (snap.file_effects) fileEffectSummary = snap.file_effects;
      if (snap.files_changed.length === 0) continue;
      persistedFilesChanged[snap.message_id] = snap.files_changed;
      latestTurnWithChanges = snap.message_id;
    }

    return { persistedFilesChanged, latestTurnWithChanges, fileEffectSummary };
  }
}

/** Shared singleton for hydrator call sites. */
export const snapshotBuilder = new SnapshotBuilder();
