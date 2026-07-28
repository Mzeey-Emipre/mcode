import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import {
  TERMINAL_PANEL_DEFAULTS,
  useTerminalStore,
} from "@/stores/terminalStore";
import { TerminalView, loadXtermModules } from "./TerminalView";
import { useTerminalPoolSlot } from "./TerminalPoolSlotContext";
import { isContainerReadyForFit } from "./safeFit";
import { dispatchTerminalPoolRefit } from "./terminalPoolRefit";
import { resolveActiveTerminalId } from "./resolveActiveTerminalId";
import { onPtyExit } from "./ptyDataRegistry";

/**
 * Mounts at most one terminal view (ADR-0010): the active shell on the active
 * scope, portaled into the right-panel slot while the Terminal tab is open.
 *
 * The last active view stays warm offscreen when the panel closes. Switching
 * terminals replaces that view only after the next terminal has hydrated from
 * server scrollback. Other shells keep running without renderer instances.
 */
export function TerminalPoolHost() {
  const { slotEl, offScreenEl } = useTerminalPoolSlot();
  const [mountEl] = useState(() => {
    const element = document.createElement("div");
    element.className = "relative h-full min-h-0 w-full overflow-hidden";
    return element;
  });
  const [warmTarget, setWarmTarget] = useState<{
    readonly scopeId: string;
    readonly ptyId: string;
  } | null>(null);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // The terminal binds to the active thread, or to the workspace itself in the
  // threadless new-thread view. The store keys this as an opaque scope id.
  const terminalScopeId = activeThreadId ?? activeWorkspaceId;
  // The whole panel record is per-thread, falling back to the workspace record
  // for the threadless shell and uncustomized threads (ADR-0012).
  const terminalTabVisible = useDiffStore((s) => {
    if (!activeWorkspaceId) return false;
    const panel = s.getRightPanel(activeWorkspaceId, activeThreadId);
    return (
      panel.visible &&
      panel.activeTab === "terminal" &&
      panel.openTabs.includes("terminal")
    );
  });

  // #749: warm the xterm module cache as soon as the terminal tab opens so the
  // first view mounts without paying the cold dynamic-import cost.
  useEffect(() => {
    if (terminalTabVisible) void loadXtermModules();
  }, [terminalTabVisible]);

  const terminals = useTerminalStore((s) => s.terminals);

  useEffect(() => {
    const unsubs = Object.values(terminals).flat().map((terminal) =>
      onPtyExit(terminal.id, () => {
        const state = useTerminalStore.getState();
        const scopeId = state.ptyToThread[terminal.id];
        if (!scopeId) return;
        state.removeTerminal(terminal.id);
        const workspace = useWorkspaceStore.getState();
        const thread = workspace.threads.find((candidate) => candidate.id === scopeId);
        const workspaceId = thread?.workspace_id ??
          (workspace.workspaces.some((candidate) => candidate.id === scopeId) ? scopeId : undefined);
        if (workspaceId) {
          useDiffStore.getState().closeRightPanelTabInstance(
            workspaceId,
            thread ? scopeId : undefined,
            `terminal:${terminal.id}`,
          );
        }
      }),
    );
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }, [terminals]);
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

  const visibleTerm =
    terminalTabVisible && terminalScopeId && activeTerminalId
      ? terminals[terminalScopeId]?.find((t) => t.id === activeTerminalId)
      : undefined;

  useLayoutEffect(() => {
    if (visibleTerm && terminalScopeId) {
      if (
        warmTarget?.scopeId !== terminalScopeId ||
        warmTarget.ptyId !== visibleTerm.id
      ) {
        setWarmTarget({ scopeId: terminalScopeId, ptyId: visibleTerm.id });
      }
      return;
    }
    if (
      warmTarget &&
      !terminals[warmTarget.scopeId]?.some(
        (terminal) => terminal.id === warmTarget.ptyId,
      )
    ) {
      setWarmTarget(null);
    }
  }, [visibleTerm, terminalScopeId, terminals, warmTarget]);

  const target = visibleTerm && terminalScopeId
    ? { scopeId: terminalScopeId, ptyId: visibleTerm.id }
    : warmTarget;
  const mountedTerm = target
    ? terminals[target.scopeId]?.find((terminal) => terminal.id === target.ptyId)
    : undefined;
  const shown = Boolean(
    visibleTerm &&
      target &&
      visibleTerm.id === target.ptyId &&
      terminalScopeId === target.scopeId,
  );
  const displayed = shown && Boolean(slotEl);
  const portalTarget = displayed ? slotEl : offScreenEl;

  useLayoutEffect(() => {
    if (portalTarget && mountEl.parentElement !== portalTarget) {
      portalTarget.appendChild(mountEl);
    }
  }, [mountEl, portalTarget]);

  useEffect(
    () => () => {
      mountEl.remove();
    },
    [mountEl],
  );

  if (!portalTarget || !mountedTerm) return null;

  return createPortal(
    <div className="absolute inset-0 flex min-h-0 flex-col">
      <TerminalView
        key={mountedTerm.id}
        ptyId={mountedTerm.id}
        visible={displayed}
        threadActive={displayed}
      />
    </div>,
    mountEl,
  );
}
