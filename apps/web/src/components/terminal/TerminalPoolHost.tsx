import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore, createDefaultRightPanelState } from "@/stores/diffStore";
import {
  TERMINAL_PANEL_DEFAULTS,
  useTerminalStore,
} from "@/stores/terminalStore";
import { TerminalView } from "./TerminalView";
import { selectTerminalPool } from "./terminalPool";
import { useTerminalPoolSlot } from "./TerminalPoolSlotContext";
import { useTerminalPtyLifecycle } from "./useTerminalPtyLifecycle";
import { isContainerReadyForFit } from "./safeFit";
import { dispatchTerminalPoolRefit } from "./terminalPoolRefit";
import { resolveActiveTerminalId } from "./resolveActiveTerminalId";

/**
 * App-level persistent pool for all xterm instances. Portals into the right-panel
 * slot when it is mounted; otherwise uses the provider's off-screen host. The slot
 * is kept as the portal target even when the panel is `hidden` so xterm DOM is not
 * moved between hosts on thread switch.
 */
export function TerminalPoolHost() {
  const { slotEl, offScreenEl } = useTerminalPoolSlot();
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

  const pool = useTerminalStore(selectTerminalPool);

  useTerminalPtyLifecycle(terminalScopeId, terminalTabVisible);

  // Prefer the in-panel slot whenever it exists so pool DOM never hops to off-screen
  // on thread switch (that hop blanks xterm until a full re-open).
  const portalTarget = slotEl ?? offScreenEl;

  const slotSized = !!slotEl && isContainerReadyForFit(slotEl);

  useLayoutEffect(() => {
    if (!terminalScopeId || !activeTerminalId) return;
    if (storedActiveTerminalId !== activeTerminalId) {
      useTerminalStore.getState().setActiveTerminal(terminalScopeId, activeTerminalId);
    }
  }, [terminalScopeId, activeTerminalId, storedActiveTerminalId]);

  useLayoutEffect(() => {
    if (!portalTarget) return;
    dispatchTerminalPoolRefit();
  }, [terminalScopeId, activeTerminalId, terminalTabVisible, portalTarget, slotSized]);

  useEffect(() => {
    if (!slotEl) return;
    const ro = new ResizeObserver(() => {
      if (isContainerReadyForFit(slotEl)) {
        dispatchTerminalPoolRefit();
      }
    });
    ro.observe(slotEl);
    return () => ro.disconnect();
  }, [slotEl]);

  const poolContent = (
    <>
      {pool.map(({ term, ownerThreadId }) => {
        const isActiveThread = ownerThreadId === terminalScopeId;
        const isShown =
          terminalTabVisible &&
          isActiveThread &&
          term.id === activeTerminalId;
        return (
          <div
            key={term.id}
            className={`absolute inset-0 flex min-h-0 flex-col ${
              isShown ? "z-10" : "pointer-events-none z-0 opacity-0"
            }`}
          >
            <TerminalView
              ptyId={term.id}
              visible={isShown}
              threadActive={isActiveThread}
            />
          </div>
        );
      })}
    </>
  );

  if (!portalTarget) return null;

  return createPortal(
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      {poolContent}
    </div>,
    portalTarget,
  );
}
