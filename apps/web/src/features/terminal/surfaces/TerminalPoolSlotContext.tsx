import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface TerminalPoolSlotContextValue {
  readonly slotEl: HTMLDivElement | null;
  readonly setSlotRef: (el: HTMLDivElement | null) => void;
  readonly offScreenEl: HTMLDivElement | null;
  readonly setOffScreenRef: (el: HTMLDivElement | null) => void;
}

const TerminalPoolSlotContext = createContext<TerminalPoolSlotContextValue | null>(
  null,
);

/**
 * Provides DOM mount targets for {@link TerminalPoolHost}: the right-panel slot
 * and a fixed off-screen host when the slot has no layout size.
 */
export function TerminalPoolSlotProvider({ children }: { readonly children: ReactNode }) {
  const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null);
  const [offScreenEl, setOffScreenEl] = useState<HTMLDivElement | null>(null);
  const setSlotRef = useCallback((el: HTMLDivElement | null) => {
    setSlotEl(el);
  }, []);
  const setOffScreenRef = useCallback((el: HTMLDivElement | null) => {
    setOffScreenEl(el);
  }, []);
  const value = useMemo(
    () => ({ slotEl, setSlotRef, offScreenEl, setOffScreenRef }),
    [slotEl, setSlotRef, offScreenEl, setOffScreenRef],
  );
  return (
    <TerminalPoolSlotContext.Provider value={value}>
      <div
        ref={setOffScreenRef}
        className="pointer-events-none fixed left-0 top-0 z-[-1] h-[480px] w-[900px] opacity-0"
        aria-hidden
      />
      {children}
    </TerminalPoolSlotContext.Provider>
  );
}

/** Returns portal slot and off-screen host refs for {@link TerminalPoolHost}. */
export function useTerminalPoolSlot(): TerminalPoolSlotContextValue {
  const ctx = useContext(TerminalPoolSlotContext);
  if (!ctx) {
    throw new Error("useTerminalPoolSlot must be used within TerminalPoolSlotProvider");
  }
  return ctx;
}

/**
 * Mount point inside the right-panel terminal tab. {@link TerminalPoolHost} portals here
 * when the slot has non-zero layout size.
 */
export function TerminalPoolSlot({ className }: { readonly className?: string }) {
  const { setSlotRef } = useTerminalPoolSlot();
  return <div ref={setSlotRef} className={className} data-testid="terminal-pool-slot" />;
}
