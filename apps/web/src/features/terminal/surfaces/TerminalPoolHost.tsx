import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TerminalBackendCapabilities } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import {
  TERMINAL_PANEL_DEFAULTS,
  useTerminalStore,
} from "@/features/terminal/state/terminalStore";
import { TerminalView, loadXtermModules } from "./TerminalView";
import { useTerminalPoolSlot } from "./TerminalPoolSlotContext";
import { isContainerReadyForFit } from "./safeFit";
import { dispatchTerminalPoolRefit } from "./terminalPoolRefit";
import { resolveActiveTerminalId } from "./resolveActiveTerminalId";

interface TerminalTarget {
  readonly scopeId: string;
  readonly ptyId: string;
}

function useTerminalTabVisible(
  activeWorkspaceId: string | null,
  activeThreadId: string | null,
): boolean {
  return useDiffStore((state) => {
    if (!activeWorkspaceId) return false;
    const panel = state.getRightPanel(activeWorkspaceId, activeThreadId);
    return panel.visible && panel.activeTab === "terminal" && panel.openTabs.includes("terminal");
  });
}

function useTerminalCapabilities(): TerminalBackendCapabilities | null {
  const [capabilities, setCapabilities] = useState<TerminalBackendCapabilities | null>(null);

  useEffect(() => {
    let disposed = false;
    void Promise.resolve()
      .then(() => getTransport().terminalCapabilities())
      .then((nextCapabilities) => {
        if (!disposed) setCapabilities(nextCapabilities);
      })
      .catch(() => {
        // Capability absence keeps unsupported recovery actions hidden.
      });
    return () => {
      disposed = true;
    };
  }, []);

  return capabilities;
}

function useResolvedActiveTerminal(
  terminalScopeId: string | null,
  terminalTabVisible: boolean,
) {
  const terminals = useTerminalStore((state) => state.terminals);
  const storedActiveTerminalId = useTerminalStore((state) =>
    terminalScopeId
      ? (state.terminalPanelByThread[terminalScopeId] ?? TERMINAL_PANEL_DEFAULTS).activeTerminalId
      : null,
  );
  const activeTerminalId = useMemo(
    () => resolveActiveTerminalId(terminalScopeId, storedActiveTerminalId, terminals),
    [terminalScopeId, storedActiveTerminalId, terminals],
  );

  useLayoutEffect(() => {
    if (!terminalScopeId || !activeTerminalId || storedActiveTerminalId === activeTerminalId) return;
    useTerminalStore.getState().setActiveTerminal(terminalScopeId, activeTerminalId);
  }, [terminalScopeId, activeTerminalId, storedActiveTerminalId]);

  const visibleTerm = terminalTabVisible && terminalScopeId && activeTerminalId
    ? terminals[terminalScopeId]?.find(
        (terminal) => terminal.id === activeTerminalId && (terminal.state ?? "running") !== "starting",
      )
    : undefined;

  return { terminals, visibleTerm };
}

function useWarmTarget(
  visibleTerm: ReturnType<typeof useResolvedActiveTerminal>["visibleTerm"],
  terminalScopeId: string | null,
  terminals: ReturnType<typeof useResolvedActiveTerminal>["terminals"],
): TerminalTarget | null {
  const [warmTarget, setWarmTarget] = useState<TerminalTarget | null>(null);

  useLayoutEffect(() => {
    if (visibleTerm && terminalScopeId) {
      const nextTarget = { scopeId: terminalScopeId, ptyId: visibleTerm.id };
      if (warmTarget?.scopeId !== nextTarget.scopeId || warmTarget?.ptyId !== nextTarget.ptyId) {
        // Keep xterm mounted while the terminal tab hides so its scrollback remains attached.
        // oxlint-disable-next-line react/set-state-in-effect -- This synchronizes the xterm mount target with the terminal store.
        setWarmTarget(nextTarget);
      }
      return;
    }
    if (warmTarget && !terminals[warmTarget.scopeId]?.some((terminal) => terminal.id === warmTarget.ptyId)) {
      // oxlint-disable-next-line react/set-state-in-effect -- Removing a closed terminal must detach its xterm mount target before paint.
      setWarmTarget(null);
    }
  }, [visibleTerm, terminalScopeId, terminals, warmTarget]);

  return visibleTerm && terminalScopeId
    ? { scopeId: terminalScopeId, ptyId: visibleTerm.id }
    : warmTarget;
}

function sameTerminalTarget(
  first: TerminalTarget | null,
  second: TerminalTarget | null,
): boolean {
  return first?.scopeId === second?.scopeId && first?.ptyId === second?.ptyId;
}

function useMountedTarget(target: TerminalTarget | null) {
  const [mountedTarget, setMountedTarget] = useState(target);
  const pendingTargetRef = useRef<TerminalTarget | null>(null);
  const handoffPendingRef = useRef(false);

  useLayoutEffect(() => {
    if (handoffPendingRef.current) {
      pendingTargetRef.current = target;
      return;
    }
    if (sameTerminalTarget(mountedTarget, target)) return;
    if (mountedTarget) {
      pendingTargetRef.current = target;
      handoffPendingRef.current = true;
      // oxlint-disable-next-line react/set-state-in-effect -- The portal handoff unmounts the old xterm before attaching the next one.
      setMountedTarget(null);
      return;
    }
    // oxlint-disable-next-line react/set-state-in-effect -- The portal handoff attaches the next xterm only after the old mount clears.
    setMountedTarget(target);
  }, [mountedTarget, target]);

  const completeHandoff = () => {
    if (!handoffPendingRef.current) return;
    handoffPendingRef.current = false;
    setMountedTarget(pendingTargetRef.current);
    pendingTargetRef.current = null;
  };

  return { mountedTarget, completeHandoff };
}

function useWarmXtermModules(terminalTabVisible: boolean): void {
  useEffect(() => {
    if (terminalTabVisible) void loadXtermModules();
  }, [terminalTabVisible]);
}

function useTerminalPoolRefit(
  slotEl: HTMLDivElement | null,
  terminalScopeId: string | null,
  visibleTerm: ReturnType<typeof useResolvedActiveTerminal>["visibleTerm"],
  terminalTabVisible: boolean,
): void {
  useLayoutEffect(() => {
    if (slotEl && isContainerReadyForFit(slotEl)) {
      dispatchTerminalPoolRefit();
    }
  }, [terminalScopeId, visibleTerm?.id, terminalTabVisible, slotEl]);
}

function usePortalMount(
  mountEl: HTMLDivElement,
  portalTarget: HTMLDivElement | null,
): void {
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
}

function findMountedTerminal(
  mountedTarget: TerminalTarget | null,
  terminals: ReturnType<typeof useResolvedActiveTerminal>["terminals"],
) {
  if (!mountedTarget) return undefined;
  return terminals[mountedTarget.scopeId]?.find((terminal) => terminal.id === mountedTarget.ptyId);
}

function isTerminalDisplayed(
  visibleTerm: ReturnType<typeof useResolvedActiveTerminal>["visibleTerm"],
  mountedTarget: TerminalTarget | null,
  terminalScopeId: string | null,
  slotEl: HTMLDivElement | null,
): boolean {
  return Boolean(
    slotEl
      && visibleTerm
      && mountedTarget
      && visibleTerm.id === mountedTarget.ptyId
      && terminalScopeId === mountedTarget.scopeId,
  );
}

function terminalPortalTarget(
  displayed: boolean,
  slotEl: HTMLDivElement | null,
  offScreenEl: HTMLDivElement | null,
): HTMLDivElement | null {
  return displayed ? slotEl : offScreenEl;
}

function terminalDiagnosticsAvailable(capabilities: TerminalBackendCapabilities | null): boolean {
  return capabilities?.contractVersion === 1 && capabilities.backend === "modern";
}

interface TerminalPoolPortalProps {
  readonly mountEl: HTMLDivElement;
  readonly slotEl: HTMLDivElement | null;
  readonly offScreenEl: HTMLDivElement | null;
  readonly terminalScopeId: string | null;
  readonly terminalCapabilities: TerminalBackendCapabilities | null;
  readonly terminals: ReturnType<typeof useResolvedActiveTerminal>["terminals"];
  readonly visibleTerm: ReturnType<typeof useResolvedActiveTerminal>["visibleTerm"];
}

function TerminalPoolPortal({
  mountEl,
  slotEl,
  offScreenEl,
  terminalScopeId,
  terminalCapabilities,
  terminals,
  visibleTerm,
}: TerminalPoolPortalProps) {
  const target = useWarmTarget(visibleTerm, terminalScopeId, terminals);
  const { mountedTarget, completeHandoff } = useMountedTarget(target);
  const mountedTerm = findMountedTerminal(mountedTarget, terminals);
  const displayed = isTerminalDisplayed(visibleTerm, mountedTarget, terminalScopeId, slotEl);
  const portalTarget = terminalPortalTarget(displayed, slotEl, offScreenEl);

  usePortalMount(mountEl, portalTarget);

  if (!portalTarget || !mountedTerm) return null;

  return createPortal(
    <div className="absolute inset-0 min-h-0">
      <TerminalView
        key={mountedTerm.id}
        ptyId={mountedTerm.id}
        ownerScopeId={mountedTerm.threadId}
        sessionState={mountedTerm.state ?? "running"}
        exit={mountedTerm.exit}
        diagnosticsAvailable={terminalDiagnosticsAvailable(terminalCapabilities)}
        visible={displayed}
        threadActive={displayed}
        onDisposed={completeHandoff}
      />
    </div>,
    mountEl,
  );
}

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
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // The terminal binds to the active thread, or to the workspace itself in the
  // threadless new-thread view. The store keys this as an opaque scope id.
  const terminalScopeId = activeThreadId ?? activeWorkspaceId;
  // The whole panel record is per-thread, falling back to the workspace record
  // for the threadless shell and uncustomized threads (ADR-0012).
  const terminalTabVisible = useTerminalTabVisible(activeWorkspaceId, activeThreadId);

  // #749: warm the xterm module cache as soon as the terminal tab opens so the
  // first view mounts without paying the cold dynamic-import cost.
  useWarmXtermModules(terminalTabVisible);

  const terminalCapabilities = useTerminalCapabilities();
  const { terminals, visibleTerm } = useResolvedActiveTerminal(terminalScopeId, terminalTabVisible);

  // Nudge the active view to refit once the slot has real layout size or when
  // the mounted target changes. The view also self-fits via its own
  // ResizeObserver; this covers the first paint after the slot appears.
  useTerminalPoolRefit(slotEl, terminalScopeId, visibleTerm, terminalTabVisible);

  return (
    <TerminalPoolPortal
      mountEl={mountEl}
      slotEl={slotEl}
      offScreenEl={offScreenEl}
      terminalScopeId={terminalScopeId}
      terminalCapabilities={terminalCapabilities}
      terminals={terminals}
      visibleTerm={visibleTerm}
    />
  );
}
