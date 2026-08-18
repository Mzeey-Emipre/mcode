/**
 * Renders late hooks (Stop / SessionEnd / PreCompact) for a completed assistant
 * message. These hooks fire after the SDK result message and are persisted
 * separately from the pre-message narrative timeline. They render between the
 * assistant text bubble and the files-changed summary.
 */

import { useMemo } from "react";
import { useThreadRecord } from "@/stores/thread-selectors";
import { HookRow } from "../narrative/HookRow";
import { recordToHookExecution } from "../narrative/build-persisted-narrative";
import type { HookExecutionRecord } from "@mcode/contracts";

/** Props for `PersistedLateHooks`. */
interface PersistedLateHooksProps {
  /** Thread whose resident narrative cache owns this assistant message. */
  threadId?: string | null;
  /** Assistant message id whose late stop hooks to render. */
  messageId: string;
}

/**
 * Renders Stop / SessionEnd / PreCompact hooks that were persisted after the
 * turn's narrative timeline was already finalised. Returns null when no such
 * hooks exist for this message so the virtualizer item occupies zero height.
 */
export function PersistedLateHooks({ threadId, messageId }: PersistedLateHooksProps) {
  const records = useThreadRecord(threadId, (r) => r.narrativeByMessage[messageId]);

  const lateHooks = useMemo<HookExecutionRecord[]>(() => {
    if (!records) return [];
    // Only hooks tagged "stop" are late hooks; "permission" hooks belong in
    // the pre-message narrative timeline rendered by PersistedNarrative.
    return records.hooks.filter((h) => h.phase === "stop");
  }, [records]);

  if (lateHooks.length === 0) return null;

  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {lateHooks.map((record, i) => (
        <HookRow key={`${record.hook_name}-${record.started_at}-${i}`} hook={recordToHookExecution(record)} />
      ))}
    </div>
  );
}
