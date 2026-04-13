import { useCallback, useRef } from "react";
import { TerminalSquare } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTerminalStore, TERMINAL_PANEL_DEFAULTS, type TerminalInstance } from "@/stores/terminalStore";
import { getTransport } from "@/transport";
import { Button } from "@/components/ui/button";
import { TerminalToolbar } from "./TerminalToolbar";
import { TerminalList } from "./TerminalList";
import { TerminalView } from "./TerminalView";

const MIN_HEIGHT = 150;
const MAX_HEIGHT_RATIO = 0.7;
const EMPTY_TERMINALS: readonly TerminalInstance[] = [];

/** Terminal panel that renders per-thread terminal instances with drag-to-resize. */
export function TerminalPanel() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);

  // One-time action refs (stable, don't trigger re-renders)
  const {
    addTerminal: storeAddTerminal,
    removeTerminal: storeRemoveTerminal,
    removeAllTerminals,
    setTerminalPanelHeight,
  } = useTerminalStore.getState();

  // Reactive subscriptions
  const panelState = useTerminalStore((s) =>
    activeThreadId
      ? (s.terminalPanelByThread[activeThreadId] ?? TERMINAL_PANEL_DEFAULTS)
      : TERMINAL_PANEL_DEFAULTS,
  );
  const { visible: panelVisible, height: panelHeight, activeTerminalId } = panelState;

  const terminals = useTerminalStore(
    (s) => (activeThreadId ? s.terminals[activeThreadId] : undefined) ?? EMPTY_TERMINALS,
  );
  const splitMode = useTerminalStore((s) => s.splitMode);

  const draggingRef = useRef(false);

  /** Handles drag-to-resize from the top edge of the panel. */
  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startY = e.clientY;
      const startHeight = panelHeight;

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startY - moveEvent.clientY;
        const maxHeight = window.innerHeight * MAX_HEIGHT_RATIO;
        const newHeight = Math.max(
          MIN_HEIGHT,
          Math.min(maxHeight, startHeight + delta),
        );
        setTerminalPanelHeight(activeThreadId!, newHeight);
      };

      const onMouseUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [panelHeight, activeThreadId, setTerminalPanelHeight],
  );

  /** Creates a new terminal for the active thread. */
  const createTerminal = useCallback(async () => {
    if (!activeThreadId) return;
    const transport = getTransport();
    const ptyId = await transport.terminalCreate(activeThreadId);
    storeAddTerminal(activeThreadId, ptyId);
  }, [activeThreadId, storeAddTerminal]);

  /** Kills and removes a single terminal. */
  const closeTerminal = useCallback(
    (ptyId: string) => {
      getTransport().terminalKill(ptyId).catch(() => {});
      storeRemoveTerminal(ptyId);
    },
    [storeRemoveTerminal],
  );

  /** Kills and removes all terminals for the active thread. */
  const closeAllTerminals = useCallback(() => {
    if (!activeThreadId) return;
    getTransport().terminalKillByThread(activeThreadId).catch(() => {});
    removeAllTerminals(activeThreadId);
  }, [activeThreadId, removeAllTerminals]);

  if (!panelVisible || !activeThreadId) {
    return null;
  }

  return (
    <div
      style={{ height: panelHeight }}
      className="flex flex-col border-t border-border bg-background"
    >
      {/* Drag handle */}
      <div
        className="h-1 cursor-row-resize bg-transparent hover:bg-muted-foreground/20"
        onMouseDown={onDragStart}
      />

      {/* Toolbar row */}
      <div className="flex justify-end px-2 py-1">
        <TerminalToolbar
          onAdd={createTerminal}
          onDeleteAll={closeAllTerminals}
        />
      </div>

      {/* Terminal views + optional split list */}
      {terminals.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <TerminalSquare className="h-10 w-10 opacity-40" />
          <p className="text-sm">No terminals</p>
          <Button variant="outline" size="sm" onClick={createTerminal}>
            New terminal
          </Button>
        </div>
      ) : (
        <div className="relative flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-hidden">
            {terminals.map((term) => (
              <TerminalView
                key={term.id}
                ptyId={term.id}
                visible={term.id === activeTerminalId}
              />
            ))}
          </div>

          {splitMode && (
            <TerminalList threadId={activeThreadId} onClose={closeTerminal} />
          )}
        </div>
      )}
    </div>
  );
}
