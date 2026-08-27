import { useMemo } from "react";
import type { HookExecutionRecord } from "@mcode/contracts";
import { useThreadRecord } from "@/stores/thread-selectors";
import { HookRow } from "./HookRow";
import { recordToHookExecution } from "./build-persisted-narrative";

/** Props for `PersistedLateHooks`. */
interface PersistedLateHooksProps {
  /** Thread whose resident narrative cache owns this assistant message. */
  threadId?: string | null;
  /** Assistant message id whose late stop hooks to render. */
  messageId: string;
}

/**
 * Renders Stop / SessionEnd / PreCompact hooks that persisted after the turn narrative.
 * Returns null when no late hooks exist so its virtual row retains no height.
 */
export function PersistedLateHooks({ threadId, messageId }: PersistedLateHooksProps) {
  const records = useThreadRecord(threadId, (record) => record.narrativeByMessage[messageId]);

  const lateHooks = useMemo<HookExecutionRecord[]>(() => {
    if (!records) return [];
    return records.hooks.filter((hook) => hook.phase === "stop");
  }, [records]);

  if (lateHooks.length === 0) return null;

  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {lateHooks.map((record, index) => (
        <HookRow key={`${record.hook_name}-${record.started_at}-${index}`} hook={recordToHookExecution(record)} />
      ))}
    </div>
  );
}
