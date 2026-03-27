import { pushEmitter } from "./ws-transport";
import { useThreadStore } from "@/stores/threadStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { clearFileListCache } from "@/components/chat/useFileAutocomplete";

/** Unsubscribe handles for all push listeners. */
let unsubs: (() => void)[] = [];

/**
 * Wire up push channel listeners that forward server events to the
 * appropriate Zustand stores. Call once at app startup.
 *
 * Push channels handled:
 * - `agent.event` -- agent stream events forwarded to threadStore
 * - `terminal.data` -- PTY output forwarded to xterm instances via custom DOM event
 * - `terminal.exit` -- PTY exit forwarded via custom DOM event
 * - `thread.status` -- thread status changes reflected in threadStore
 * - `files.changed` -- invalidates the file autocomplete cache
 * - `skills.changed` -- reserved for future skill cache invalidation
 */
export function startPushListeners(): void {
  // Guard against double-init
  stopPushListeners();

  const handleAgentEvent = useThreadStore.getState().handleAgentEvent;

  // agent.event: the server wraps each sidecar event with { threadId, type, ... }
  unsubs.push(
    pushEmitter.on("agent.event", (data) => {
      const event = data as Record<string, unknown>;
      const threadId = event.threadId as string;
      if (!threadId) return;

      // Map the flat contract AgentEvent into the method-keyed shape
      // that handleAgentEvent expects (method = "session.<type>").
      const type = event.type as string;
      const method = `session.${type}`;
      handleAgentEvent(threadId, { method, ...event });
    }),
  );

  // terminal.data: broadcast to TerminalView instances via CustomEvent
  unsubs.push(
    pushEmitter.on("terminal.data", (data) => {
      const payload = data as { ptyId: string; data: string };
      window.dispatchEvent(
        new CustomEvent("mcode:pty-data", { detail: payload }),
      );
    }),
  );

  // terminal.exit: broadcast exit event
  unsubs.push(
    pushEmitter.on("terminal.exit", (data) => {
      const payload = data as { ptyId: string; code: number };
      window.dispatchEvent(
        new CustomEvent("mcode:pty-exit", { detail: payload }),
      );
      // Remove the terminal from the store after a brief delay so the
      // exit message has time to render.
      setTimeout(() => {
        useTerminalStore.getState().removeTerminal(payload.ptyId);
      }, 2000);
    }),
  );

  // thread.status: update running state in the thread store
  unsubs.push(
    pushEmitter.on("thread.status", (data) => {
      const { threadId, status } = data as {
        threadId: string;
        status: string;
      };
      // The workspace store mirrors thread status; import lazily to
      // avoid circular deps at module evaluation time.
      import("@/stores/workspaceStore").then(({ useWorkspaceStore }) => {
        useWorkspaceStore.setState((ws) => ({
          threads: ws.threads.map((t) =>
            t.id === threadId ? { ...t, status: status as typeof t.status } : t,
          ),
        }));
      });
    }),
  );

  // files.changed: invalidate file autocomplete cache
  unsubs.push(
    pushEmitter.on("files.changed", (data) => {
      const { workspaceId, threadId } = data as {
        workspaceId: string;
        threadId?: string;
      };
      clearFileListCache(workspaceId, threadId);
    }),
  );

  // skills.changed: reserved for future skill cache invalidation
  unsubs.push(
    pushEmitter.on("skills.changed", () => {
      // No-op for now; will invalidate skill cache when implemented.
    }),
  );
}

/** Remove all push channel listeners. Safe to call multiple times. */
export function stopPushListeners(): void {
  for (const unsub of unsubs) {
    unsub();
  }
  unsubs = [];
}
