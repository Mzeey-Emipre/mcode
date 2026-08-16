import { useDiffStore } from "@/stores/diffStore";
import { MAX_TERMINALS_PER_SCOPE, useTerminalStore } from "@/features/terminal";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { getTransport } from "@/transport";

/**
 * Scopes with an in-flight terminal creation. Shared module-level guard so
 * concurrent triggers (tab click, the mod+j keybinding, React strict-mode
 * double-invoked effects) spawn at most one terminal per scope.
 */
const creationInFlight = new Set<string>();

/**
 * Resolve the workspace that owns a terminal scope. The scope is a thread id
 * when a thread is active, or a workspace id for the threadless new-thread
 * shell, so look the scope up as a thread first and fall back to a workspace.
 */
function resolveScopeWorkspace(scopeId: string): {
  workspaceId: string | undefined;
  isThread: boolean;
} {
  const ws = useWorkspaceStore.getState();
  const thread = ws.threads.find((t) => t.id === scopeId);
  if (thread) return { workspaceId: thread.workspace_id, isThread: true };
  if (ws.workspaces.some((w) => w.id === scopeId)) {
    return { workspaceId: scopeId, isThread: false };
  }
  return { workspaceId: undefined, isThread: false };
}

/**
 * Creates one terminal and its matching right-panel rail tab. Creation is
 * serialized per scope so concurrent UI and shortcut requests cannot exceed the
 * session cap.
 *
 * @param scopeId - A thread id, or a workspace id for the threadless shell.
 */
export function createTerminalForScope(scopeId: string): void {
  if (creationInFlight.has(scopeId)) return;
  const existing = useTerminalStore.getState().terminals[scopeId];
  if ((existing?.length ?? 0) >= MAX_TERMINALS_PER_SCOPE) return;

  creationInFlight.add(scopeId);
  try {
    const transport = getTransport();
    transport
      .terminalCreate(scopeId)
      .then(({ ptyId, shell }) => {
        creationInFlight.delete(scopeId);
        // The panel record is per-thread (or the workspace fallback for the
        // threadless shell). Resolve the owning workspace, then read the scope's
        // effective record, passing the thread id only when the scope is a thread.
        const { workspaceId, isThread } = resolveScopeWorkspace(scopeId);
        const panelThreadId = isThread ? scopeId : undefined;
        const diff = useDiffStore.getState();
        const panel = workspaceId
          ? diff.getRightPanel(workspaceId, panelThreadId)
          : undefined;
        const panelVisible = workspaceId
          ? diff.getRightPanelVisible(workspaceId, panelThreadId)
          : false;
        if (!panel || !panelVisible) {
          transport.terminalKill(ptyId).catch(() => {});
          return;
        }
        const current = useTerminalStore.getState().terminals[scopeId];
        if ((current?.length ?? 0) >= MAX_TERMINALS_PER_SCOPE) {
          transport.terminalKill(ptyId).catch(() => {});
          return;
        }
        useTerminalStore.getState().addTerminal(scopeId, ptyId, shell);
        diff.addRightPanelTerminalTab(workspaceId!, panelThreadId, ptyId);
      })
      .catch(() => {
        creationInFlight.delete(scopeId);
      });
  } catch {
    creationInFlight.delete(scopeId);
  }
}

/** Ensures a Terminal tab has its first PTY-backed rail instance. */
export function ensureTerminalForScope(scopeId: string): void {
  if ((useTerminalStore.getState().terminals[scopeId]?.length ?? 0) === 0) {
    createTerminalForScope(scopeId);
  }
}
