import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { TerminalToolbar } from "./TerminalToolbar";
import { TerminalList } from "./TerminalList";
import { TerminalView } from "./TerminalView";

const DEFAULT_HEIGHT = 300;
const MIN_HEIGHT = 150;
const MAX_HEIGHT_RATIO = 0.7;

export function TerminalPanel() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const panelVisible = useTerminalStore((s) => s.panelVisible);
  const splitMode = useTerminalStore((s) => s.splitMode);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);
  const removeAllTerminals = useTerminalStore((s) => s.removeAllTerminals);

  const terminals = useTerminalStore(
    (s) => (activeThreadId ? s.terminals[activeThreadId] : undefined) ?? [],
  );

  const [panelHeight, setPanelHeight] = useState(DEFAULT_HEIGHT);
  const draggingRef = useRef(false);

  // Drag handle resizing
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
        setPanelHeight(newHeight);
      };

      const onMouseUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [panelHeight],
  );

  // Create a new terminal for the active thread
  const createTerminal = useCallback(async () => {
    if (!activeThreadId) return;
    const api = window.electronAPI;
    if (!api) return;
    const ptyId = (await api.invoke("pty:create", activeThreadId)) as string;
    addTerminal(activeThreadId, ptyId);
  }, [activeThreadId, addTerminal]);

  // Close a single terminal
  const closeTerminal = useCallback(
    (ptyId: string) => {
      window.electronAPI?.invoke("pty:kill", ptyId);
      removeTerminal(ptyId);
    },
    [removeTerminal],
  );

  // Close all terminals for the active thread
  const closeAllTerminals = useCallback(() => {
    if (!activeThreadId) return;
    for (const t of terminals) {
      window.electronAPI?.invoke("pty:kill", t.id);
    }
    removeAllTerminals(activeThreadId);
  }, [activeThreadId, terminals, removeAllTerminals]);

  // Auto-create first terminal when panel opens with none
  useEffect(() => {
    if (panelVisible && activeThreadId && terminals.length === 0) {
      createTerminal();
    }
  }, [panelVisible, activeThreadId, terminals.length, createTerminal]);

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
          threadId={activeThreadId}
          onAdd={createTerminal}
          onDeleteAll={closeAllTerminals}
        />
      </div>

      {/* Terminal views + optional split list */}
      <div className="flex flex-1 overflow-hidden">
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
    </div>
  );
}
