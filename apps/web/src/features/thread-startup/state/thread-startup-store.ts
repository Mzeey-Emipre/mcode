import { useEffect } from "react";
import { create } from "zustand";
import type { ThreadStartup } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useConnectionStore } from "@/stores/connectionStore";

interface ThreadStartupState {
  readonly recordsByStartupId: Readonly<Record<string, ThreadStartup>>;
  readonly startupIdByThreadId: Readonly<Record<string, string>>;
  apply: (startup: ThreadStartup) => void;
  recover: (input: { readonly startupId?: string; readonly workspaceId?: string }) => Promise<void>;
}

function startupForThread(
  recordsByStartupId: Readonly<Record<string, ThreadStartup>>,
  startupIdByThreadId: Readonly<Record<string, string>>,
  startupId: string | undefined,
  threadId: string | undefined,
): ThreadStartup | undefined {
  if (startupId) return recordsByStartupId[startupId];
  return threadId ? recordsByStartupId[startupIdByThreadId[threadId] ?? ""] : undefined;
}

/** Holds authoritative startup records and their durable thread bindings. */
export const useThreadStartupStore = create<ThreadStartupState>((set) => ({
  recordsByStartupId: {},
  startupIdByThreadId: {},
  apply: (startup) => set((state) => {
    const current = state.recordsByStartupId[startup.startupId];
    if (current && current.revision >= startup.revision) return state;
    return {
      recordsByStartupId: {
        ...state.recordsByStartupId,
        [startup.startupId]: startup,
      },
      startupIdByThreadId: startup.threadId
        ? { ...state.startupIdByThreadId, [startup.threadId]: startup.startupId }
        : state.startupIdByThreadId,
    };
  }),
  recover: async ({ startupId, workspaceId }) => {
    const transport = getTransport();
    const [record, list] = await Promise.all([
      startupId ? transport.getThreadStartup(startupId) : Promise.resolve(null),
      workspaceId ? transport.listThreadStartups(workspaceId) : Promise.resolve(null),
    ]);
    const store = useThreadStartupStore.getState();
    if (record) store.apply(record);
    for (const startup of list?.records ?? []) store.apply(startup);
  },
}));

/** Reads one startup by its client identity or its bound durable thread. */
export function useThreadStartup({
  startupId,
  threadId,
  workspaceId,
  enabled = true,
}: {
  readonly startupId?: string;
  readonly threadId?: string;
  readonly workspaceId?: string;
  readonly enabled?: boolean;
}): ThreadStartup | undefined {
  const startup = useThreadStartupStore((state) => startupForThread(
    state.recordsByStartupId,
    state.startupIdByThreadId,
    startupId,
    threadId,
  ));
  const connectionStatus = useConnectionStore((state) => state.status);

  useEffect(() => {
    if (!enabled || connectionStatus !== "connected") return;
    void useThreadStartupStore.getState().recover({ startupId, workspaceId }).catch(() => undefined);
  }, [connectionStatus, enabled, startupId, workspaceId]);

  return startup;
}
