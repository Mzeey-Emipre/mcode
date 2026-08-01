import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MousePointer2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

const AVAILABILITY_STATES = [
  { key: "available", label: "Available" },
  { key: "closed", label: "Closed" },
] as const;

type AvailabilityState = (typeof AVAILABILITY_STATES)[number]["key"];

const PROTOTYPE_STATE_EVENT = "mcode:background-browser-overview-prototype";
const ACTIVE_TAB_TITLE = "Mcode";
const ACTIVE_TAB_ORIGIN = "127.0.0.1:41633";

function readPrototypeState(): AvailabilityState | null {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("backgroundBrowserPrototype")) return null;
  return params.get("backgroundBrowserState") === "closed" ? "closed" : "available";
}

function replacePrototypeState(state: AvailabilityState): void {
  const url = new URL(window.location.href);
  url.searchParams.set("backgroundBrowserPrototype", "section");
  url.searchParams.set("backgroundBrowserState", state);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(PROTOTYPE_STATE_EVENT));
}

interface BrowserSectionProps {
  readonly state: AvailabilityState;
  readonly onInspect: () => void;
}

function BrowserSection({ state, onInspect }: BrowserSectionProps) {
  if (state === "closed") return null;

  return (
    <section aria-label="Browser" data-testid="background-browser-section">
      <Separator className="my-1.5" />
      <div className="px-2 pt-1 text-xs font-medium text-muted-foreground">Browser</div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onInspect}
        aria-label={`Browser, ${ACTIVE_TAB_TITLE}, ${ACTIVE_TAB_ORIGIN}, open Browser tab`}
        className="group h-8 w-full justify-between gap-3 px-2 text-left transition-[background-color,color,transform] duration-150 ease-out active:translate-y-px motion-reduce:transform-none"
      >
        <span className="flex min-w-0 items-center gap-2">
          <MousePointer2
            className="size-3.5 shrink-0 fill-primary text-primary"
            aria-label="Agent controls this Browser tab"
          />
          <span className="truncate text-xs font-medium">{ACTIVE_TAB_TITLE}</span>
        </span>
        <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-right font-mono text-xs tabular-nums text-muted-foreground [mask-image:linear-gradient(to_right,transparent_0,black_1.25rem)]">
          {ACTIVE_TAB_ORIGIN}
        </span>
      </Button>
    </section>
  );
}

interface PrototypeSwitcherProps {
  readonly state: AvailabilityState;
  readonly onChange: (next: AvailabilityState) => void;
}

function PrototypeSwitcher({ state, onChange }: PrototypeSwitcherProps) {
  const cycleState = useCallback((direction: -1 | 1) => {
    const index = AVAILABILITY_STATES.findIndex((candidate) => candidate.key === state);
    const nextIndex = (index + direction + AVAILABILITY_STATES.length) % AVAILABILITY_STATES.length;
    onChange(AVAILABILITY_STATES[nextIndex].key);
  }, [onChange, state]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches("input, textarea, [contenteditable='true']") || target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowLeft") cycleState(-1);
      if (event.key === "ArrowRight") cycleState(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycleState]);

  return createPortal(
    <div className="fixed bottom-4 left-1/2 z-50 w-fit max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-md">
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <span className="px-1 text-xs font-medium text-muted-foreground">Prototype</span>
        {AVAILABILITY_STATES.map((candidate) => (
          <Button
            key={candidate.key}
            type="button"
            variant={state === candidate.key ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onChange(candidate.key)}
            aria-pressed={state === candidate.key}
          >
            {candidate.label}
          </Button>
        ))}
      </div>
      <p className="mt-1 text-center font-mono text-xs text-muted-foreground">
        availability={state} · section={state === "closed" ? "hidden" : "visible"} · icon=agent-cursor
      </p>
    </div>,
    document.body,
  );
}

/** Throwaway, development-only Browser section for Wayfinder ticket 1037. */
export function ThreadOverviewBrowserPrototype() {
  const [state, setState] = useState<AvailabilityState | null>(() => (
    import.meta.env.DEV ? readPrototypeState() : null
  ));
  const [inspectionMessage, setInspectionMessage] = useState("");
  const showControls = new URLSearchParams(window.location.search).get("backgroundBrowserControls") !== "hidden";

  const updateState = useCallback((next: AvailabilityState): void => {
    setState(next);
    setInspectionMessage("");
    replacePrototypeState(next);
  }, []);

  useEffect(() => {
    const syncFromUrl = (): void => setState(readPrototypeState());
    window.addEventListener("popstate", syncFromUrl);
    window.addEventListener(PROTOTYPE_STATE_EVENT, syncFromUrl);
    return () => {
      window.removeEventListener("popstate", syncFromUrl);
      window.removeEventListener(PROTOTYPE_STATE_EVENT, syncFromUrl);
    };
  }, []);

  if (!import.meta.env.DEV || !state) return null;

  return (
    <>
      <BrowserSection
        state={state}
        onInspect={() => setInspectionMessage(`Prototype: Would open this thread's ${ACTIVE_TAB_TITLE} Browser tab.`)}
      />
      {inspectionMessage ? (
        <p className="sr-only" role="status" aria-live="polite">{inspectionMessage}</p>
      ) : null}
      {showControls ? <PrototypeSwitcher state={state} onChange={updateState} /> : null}
    </>
  );
}
