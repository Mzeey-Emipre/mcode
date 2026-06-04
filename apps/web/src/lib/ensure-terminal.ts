import { useDiffStore } from "@/stores/diffStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { getTransport } from "@/transport";

/**
 * Threads with an in-flight terminal creation. Shared module-level guard so
 * concurrent triggers (tab click, the mod+j keybinding, React strict-mode
 * double-invoked effects) spawn at most one terminal per thread.
 */
const creationInFlight = new Set<string>();

/**
 * Spawns a terminal for the thread when it has none, so opening the Terminal
 * tab lands the user in a ready shell instead of an empty pane (the "anticipate
 * the next step" product principle).
 *
 * No-op when a terminal already exists or a creation is already in flight. If
 * the Terminal tab is no longer the visible target by the time the PTY is ready
 * (the user closed the panel or switched tabs mid-creation), the orphaned PTY
 * is killed rather than added to the store.
 *
 * @param threadId - The thread to ensure a terminal for.
 */
export function ensureTerminalForThread(threadId: string): void {
  if (creationInFlight.has(threadId)) return;
  const existing = useTerminalStore.getState().terminals[threadId];
  if (existing && existing.length > 0) return;

  creationInFlight.add(threadId);
  try {
    const transport = getTransport();
    transport
      .terminalCreate(threadId)
      .then(({ ptyId, shell }) => {
        creationInFlight.delete(threadId);
        const panel = useDiffStore.getState().getRightPanel(threadId);
        // Panel closed or tab switched while creation was in flight — dispose
        // the orphaned PTY instead of adding a terminal nobody asked to see.
        if (!panel.visible || panel.activeTab !== "terminal") {
          transport.terminalKill(ptyId).catch(() => {});
          return;
        }
        const current = useTerminalStore.getState().terminals[threadId];
        if (!current || current.length === 0) {
          useTerminalStore.getState().addTerminal(threadId, ptyId, shell);
        } else {
          transport.terminalKill(ptyId).catch(() => {});
        }
      })
      .catch(() => {
        creationInFlight.delete(threadId);
      });
  } catch {
    creationInFlight.delete(threadId);
  }
}
