import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronLeft,
  ChevronRight,
  Globe,
  MousePointer2,
  Square,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const VARIANTS = [
  { key: "A", name: "Command capsule" },
  { key: "B", name: "Pointer tether" },
  { key: "C", name: "Control shelf" },
] as const;

const SCENARIOS = [
  { key: "pointer", label: "Pointer action", action: "Clicking Open project" },
  { key: "observe", label: "No pointer", action: "Reading visible page" },
  { key: "human", label: "You control", action: null },
  { key: "idle", label: "Idle", action: null },
] as const;

const BROWSER_CONTROL_PROTOTYPE_STATE_EVENT = "mcode:browser-control-prototype-state";

type VariantKey = (typeof VARIANTS)[number]["key"];
type ScenarioKey = (typeof SCENARIOS)[number]["key"];
type ExecutorKey = "web" | "electron";

interface PrototypeState {
  readonly variant: VariantKey;
  readonly scenario: ScenarioKey;
  readonly executor: ExecutorKey;
}

function isVariantKey(value: string | null): value is VariantKey {
  return VARIANTS.some((variant) => variant.key === value);
}

function isScenarioKey(value: string | null): value is ScenarioKey {
  return SCENARIOS.some((scenario) => scenario.key === value);
}

function readPrototypeState(): PrototypeState {
  const params = new URLSearchParams(window.location.search);
  const variant = params.get("browserControlPrototype");
  const scenario = params.get("browserControlScenario");
  const executor = params.get("browserControlExecutor");
  return {
    variant: isVariantKey(variant) ? variant : "A",
    scenario: isScenarioKey(scenario) ? scenario : "pointer",
    executor: executor === "electron" ? "electron" : "web",
  };
}

function replacePrototypeSearch(state: PrototypeState): void {
  const url = new URL(window.location.href);
  url.searchParams.set("browserControlPrototype", state.variant);
  url.searchParams.set("browserControlScenario", state.scenario);
  url.searchParams.set("browserControlExecutor", state.executor);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(BROWSER_CONTROL_PROTOTYPE_STATE_EVENT));
}

interface StopControlProps {
  readonly className?: string;
  readonly onStop: () => void;
}

function StopControl({ className, onStop }: StopControlProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn("h-7 gap-1.5 border-primary/35 bg-background/95 px-2 text-xs", className)}
      onClick={onStop}
      aria-label="Stop Browser control"
    >
      <Square className="size-3 fill-current" aria-hidden />
      Stop
    </Button>
  );
}

interface AgentOverlayProps {
  readonly action: string;
  readonly pointerVisible: boolean;
  readonly variant: VariantKey;
  readonly onStop: () => void;
}

function AgentOverlay({ action, pointerVisible, variant, onStop }: AgentOverlayProps) {
  if (variant === "A") {
    return (
      <div
        className="pointer-events-none absolute inset-0 z-20"
        data-testid="browser-control-prototype-overlay"
        style={{
          boxShadow: [
            "inset 0 0 0 1px color-mix(in oklab, var(--primary) 28%, transparent)",
            "inset 0 0 28px color-mix(in oklab, var(--primary) 12%, transparent)",
            "0 0 20px color-mix(in oklab, var(--primary) 10%, transparent)",
          ].join(", "),
        }}
      >
        <span className="sr-only" role="status" aria-live="polite">
          Agent controls Browser. {action}
        </span>
        {pointerVisible ? (
          <div
            className="absolute left-[62%] top-[48%] flex items-start gap-1.5"
            aria-hidden
          >
            <MousePointer2
              className="size-5 fill-primary text-primary"
              style={{
                filter: [
                  "drop-shadow(0 0 5px color-mix(in oklab, var(--primary) 72%, transparent))",
                  "drop-shadow(0 2px 5px rgb(0 0 0 / 0.35))",
                ].join(" "),
              }}
            />
          </div>
        ) : null}
      </div>
    );
  }

  if (variant === "B") {
    return (
      <div
        className="pointer-events-none absolute inset-0 z-20 ring-1 ring-inset ring-primary/40"
        data-testid="browser-control-prototype-overlay"
      >
        <Badge
          variant="outline"
          className="absolute left-2 top-2 gap-1 border-primary/35 bg-background/95 text-foreground shadow-sm"
          role="status"
          aria-live="polite"
        >
          <Bot className="size-3 text-primary" aria-hidden />
          Agent
        </Badge>
        <StopControl className="pointer-events-auto absolute right-2 top-2" onStop={onStop} />
        {pointerVisible ? (
          <div className="absolute left-[53%] top-[52%] flex items-start gap-2">
            <MousePointer2
              className="size-5 shrink-0 fill-primary text-primary-foreground drop-shadow-sm"
              aria-hidden
            />
            <div className="rounded-md border border-primary/35 bg-background/95 px-2 py-1 shadow-sm">
              <p className="text-xs font-medium text-foreground">{action}</p>
            </div>
          </div>
        ) : (
          <div className="absolute left-2 top-9 rounded-md border border-primary/35 bg-background/95 px-2 py-1 shadow-sm">
            <p className="text-xs font-medium text-foreground">{action}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 ring-2 ring-inset ring-primary/45"
      data-testid="browser-control-prototype-overlay"
    >
      {pointerVisible ? (
        <MousePointer2
          className="absolute left-[62%] top-[46%] size-5 fill-primary text-primary-foreground drop-shadow-sm"
          aria-hidden
        />
      ) : null}
      <div
        className="pointer-events-auto absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-lg border border-primary/35 bg-background/95 p-1.5 pl-2 shadow-md"
        role="status"
        aria-live="polite"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-xs font-medium">Agent controls Browser</span>
          <span className="truncate text-xs text-muted-foreground">{action}</span>
        </div>
        <StopControl onStop={onStop} />
      </div>
    </div>
  );
}

interface PrototypeSwitcherProps {
  readonly state: PrototypeState;
  readonly onChange: (next: PrototypeState) => void;
}

function PrototypeSwitcher({ state, onChange }: PrototypeSwitcherProps) {
  const selectedVariant = VARIANTS.find((variant) => variant.key === state.variant) ?? VARIANTS[0];
  const agentActive = state.scenario === "pointer" || state.scenario === "observe";
  const pointerVisible = state.scenario === "pointer";

  const cycleVariant = useCallback((direction: -1 | 1) => {
    const index = VARIANTS.findIndex((variant) => variant.key === state.variant);
    const nextIndex = (index + direction + VARIANTS.length) % VARIANTS.length;
    onChange({ ...state, variant: VARIANTS[nextIndex].key });
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
      if (event.key === "ArrowLeft") cycleVariant(-1);
      if (event.key === "ArrowRight") cycleVariant(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycleVariant]);

  return (
    <div className="fixed bottom-14 left-1/2 z-50 w-fit max-w-4xl -translate-x-1/2 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-md">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Badge variant="outline" size="sm">Prototype</Badge>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => cycleVariant(-1)}
            aria-label="Previous overlay variant"
          >
            <ChevronLeft aria-hidden />
          </Button>
          <span className="min-w-36 text-center text-sm font-medium">
            {selectedVariant.key} · {selectedVariant.name}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => cycleVariant(1)}
            aria-label="Next overlay variant"
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
        <div className="h-5 w-px bg-border" aria-hidden />
        {(["web", "electron"] as const).map((executor) => (
          <Button
            key={executor}
            type="button"
            variant={state.executor === executor ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onChange({ ...state, executor })}
            aria-pressed={state.executor === executor}
          >
            {executor === "web" ? <Globe aria-hidden /> : <Bot aria-hidden />}
            {executor === "web" ? "Web" : "Electron"}
          </Button>
        ))}
        <div className="h-5 w-px bg-border" aria-hidden />
        {SCENARIOS.map((scenario) => (
          <Button
            key={scenario.key}
            type="button"
            variant={state.scenario === scenario.key ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onChange({ ...state, scenario: scenario.key })}
            aria-pressed={state.scenario === scenario.key}
          >
            {scenario.label}
          </Button>
        ))}
      </div>
      <p className="mt-1 text-center font-mono text-xs text-muted-foreground">
        executor={state.executor} · controller={agentActive ? "agent" : state.scenario === "human" ? "human" : "none"} · overlay={agentActive ? "visible" : "hidden"} · pointer={pointerVisible ? "visible" : "hidden"} · stop={agentActive && state.variant !== "A" ? "visible" : "hidden"}
      </p>
    </div>
  );
}

/** Throwaway, development-only Browser control overlay comparison for Wayfinder ticket 1033. */
export function BrowserControlOverlayPrototype() {
  const [state, setState] = useState<PrototypeState>(readPrototypeState);
  const scenario = SCENARIOS.find((candidate) => candidate.key === state.scenario) ?? SCENARIOS[0];
  const agentActive = state.scenario === "pointer" || state.scenario === "observe";

  const updateState = useCallback((next: PrototypeState): void => {
    setState(next);
    replacePrototypeSearch(next);
  }, []);

  const stopBrowser = useCallback((): void => {
    updateState({ ...state, scenario: "idle" });
  }, [state, updateState]);

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background" data-testid="browser-control-prototype">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Back">
          <ArrowLeft aria-hidden />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Forward">
          <ArrowRight aria-hidden />
        </Button>
        <Input
          size="sm"
          value="http://127.0.0.1:3000"
          readOnly
          aria-label="Preview address"
          className="mx-1 min-w-0 flex-1"
        />
        <Badge variant="outline" className="shrink-0">
          {state.executor === "web" ? "Web" : "Electron"}
        </Badge>
      </div>

      <div className="relative min-h-0 flex-1 bg-background">
        <div className="grid h-full grid-cols-[8rem_minmax(0,1fr)] text-foreground">
          <nav className="border-r border-border bg-muted/30 p-3" aria-label="Fixture navigation">
            <p className="mb-4 text-sm font-semibold">Fixture page</p>
            <div className="space-y-1 text-xs text-muted-foreground">
              <p className="rounded-md bg-muted px-2 py-1.5 text-foreground">Overview</p>
              <p className="px-2 py-1.5">Projects</p>
              <p className="px-2 py-1.5">Activity</p>
            </div>
          </nav>
          <main className="min-w-0 overflow-auto p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Workspace</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">Browser overlay fixture</h2>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              The page stays visually native when no agent controls this Browser tab.
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <section className="rounded-lg border border-border p-4">
                <h3 className="text-sm font-medium">Open project</h3>
                <p className="mt-1 text-xs text-muted-foreground">Continue into a bounded local workspace.</p>
                <Button type="button" size="sm" className="mt-4">Open project</Button>
              </section>
              <section className="rounded-lg border border-border p-4">
                <h3 className="text-sm font-medium">Review activity</h3>
                <p className="mt-1 text-xs text-muted-foreground">Inspect recent Browser actions.</p>
                <Button type="button" variant="outline" size="sm" className="mt-4">View activity</Button>
              </section>
            </div>
          </main>
        </div>

        {agentActive && scenario.action ? (
          <AgentOverlay
            action={scenario.action}
            pointerVisible={state.scenario === "pointer"}
            variant={state.variant}
            onStop={stopBrowser}
          />
        ) : null}

      </div>

      <PrototypeSwitcher state={state} onChange={updateState} />
    </div>
  );
}
