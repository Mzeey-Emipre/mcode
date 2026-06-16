import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore, createDefaultRightPanelState } from "@/stores/diffStore";
import {
  TERMINAL_PANEL_DEFAULTS,
  useTerminalStore,
} from "@/stores/terminalStore";
import { TerminalView, loadXtermModules } from "./TerminalView";
import { useTerminalPoolSlot } from "./TerminalPoolSlotContext";
import { isContainerReadyForFit } from "./safeFit";
import { dispatchTerminalPoolRefit } from "./terminalPoolRefit";
import { resolveActiveTerminalId } from "./resolveActiveTerminalId";

/**
 * Mounts at most one terminal view (ADR-0010): the active shell on the active
 * scope, portaled into the right-panel slot while the Terminal tab is open.
 *
 * Background shells — other tabs, other threads — keep running server-side with
 * their output draining into the server scrollback buffer; their views are
 * disposed and remounted via `terminal.reattach` (see {@link TerminalView}).
 * This replaces the former persistent pool that kept every shell's xterm
 * mounted and hidden, which scaled memory and main-thread cost with every
 * long-running shell.
 */
export function TerminalPoolHost() {
  const { slotEl } = useTerminalPoolSlot();
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // The terminal binds to the active thread, or to the workspace itself in the
  // threadless new-thread view. The store keys this as an opaque scope id.
  const terminalScopeId = activeThreadId ?? activeWorkspaceId;
  const storedPanel = useDiffStore((s) =>
    activeWorkspaceId ? s.rightPanelByWorkspace[activeWorkspaceId] : undefined,
  );
  const panelState = useMemo(
    () => storedPanel ?? createDefaultRightPanelState(),
    [storedPanel],
  );
  // Open/closed is per-thread, falling back to the workspace threadless shell.
  // The active tab stays workspace-global.
  const panelVisible = useDiffStore((s) =>
    activeWorkspaceId
      ? s.getRightPanelVisible(activeWorkspaceId, activeThreadId)
      : false,
  );
  const terminalTabVisible =
    panelVisible && panelState.activeTab === "terminal";

  // #749: warm the xterm module cache as soon as the terminal tab opens so the
  // first view mounts without paying the cold dynamic-import cost.
  useEffect(() => {
    if (terminalTabVisible) void loadXtermModules();
  }, [terminalTabVisible]);

  const terminals = useTerminalStore((s) => s.terminals);
  const storedActiveTerminalId = useTerminalStore((s) =>
    terminalScopeId
      ? (s.terminalPanelByThread[terminalScopeId] ?? TERMINAL_PANEL_DEFAULTS)
          .activeTerminalId
      : null,
  );

  const activeTerminalId = useMemo(
    () =>
      resolveActiveTerminalId(
        terminalScopeId,
        storedActiveTerminalId,
        terminals,
      ),
    [terminalScopeId, storedActiveTerminalId, terminals],
  );

  // Persist the resolved active terminal so the selection survives reloads and
  // matches what the tab list highlights.
  useLayoutEffect(() => {
    if (!terminalScopeId || !activeTerminalId) return;
    if (storedActiveTerminalId !== activeTerminalId) {
      useTerminalStore.getState().setActiveTerminal(terminalScopeId, activeTerminalId);
    }
  }, [terminalScopeId, activeTerminalId, storedActiveTerminalId]);

  // Nudge the active view to refit once the slot has real layout size or when
  // the mounted target changes. The view also self-fits via its own
  // ResizeObserver; this covers the first paint after the slot appears.
  useLayoutEffect(() => {
    if (slotEl && isContainerReadyForFit(slotEl)) {
      dispatchTerminalPoolRefit();
    }
  }, [terminalScopeId, activeTerminalId, terminalTabVisible, slotEl]);

  // The single shell whose view should be mounted right now, or undefined when
  // the terminal tab is hidden or the scope has no terminals.
  const activeTerm =
    terminalTabVisible && terminalScopeId && activeTerminalId
      ? terminals[terminalScopeId]?.find((t) => t.id === activeTerminalId)
      : undefined;

  // Mount only into the in-panel slot. When it is absent (panel closed/tab
  // hidden) the view stays unmounted and the shell keeps draining server-side.
  if (!slotEl || !activeTerm) return null;

  return createPortal(
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      <div className="absolute inset-0 flex min-h-0 flex-col">
        {/* key by ptyId so switching shell/thread disposes the old view and
            mounts a fresh one that reattaches at the latest output. */}
        <TerminalView key={activeTerm.id} ptyId={activeTerm.id} visible threadActive />
      </div>
    </div>,
    slotEl,
  );
}
