import { useDiffStore } from "@/stores/diffStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
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
 * Spawns a terminal for the scope when it has none, so opening the Terminal
 * tab lands the user in a ready shell instead of an empty pane (the "anticipate
 * the next step" product principle).
 *
 * No-op when a terminal already exists or a creation is already in flight. If
 * the Terminal tab is no longer the visible target by the time the PTY is ready
 * (the user closed the panel or switched tabs mid-creation), the orphaned PTY
 * is killed rather than added to the store.
 *
 * @param scopeId - A thread id, or a workspace id for the threadless shell.
 */
export function ensureTerminalForScope(scopeId: string): void {
  if (creationInFlight.has(scopeId)) return;
  const existing = useTerminalStore.getState().terminals[scopeId];
  if (existing && existing.length > 0) return;

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
        // Panel closed or tab switched while creation was in flight — dispose
        // the orphaned PTY instead of adding a terminal nobody asked to see.
        if (!panel || !panelVisible || panel.activeTab !== "terminal") {
          transport.terminalKill(ptyId).catch(() => {});
          return;
        }
        const current = useTerminalStore.getState().terminals[scopeId];
        if (!current || current.length === 0) {
          useTerminalStore.getState().addTerminal(scopeId, ptyId, shell);
        } else {
          transport.terminalKill(ptyId).catch(() => {});
        }
      })
      .catch(() => {
        creationInFlight.delete(scopeId);
      });
  } catch {
    creationInFlight.delete(scopeId);
  }
}
