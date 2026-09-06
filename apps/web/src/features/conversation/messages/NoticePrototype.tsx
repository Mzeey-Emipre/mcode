import { useEffect, useMemo, useState } from "react";
import { Info, TriangleAlert, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NoticePrototypeComposer } from "./NoticePrototypeComposer";

type Variant = "A" | "B" | "C";
type Scenario =
  | "Working"
  | "Sign-in required"
  | "Model changed"
  | "Security warning"
  | "Configuration";
const variants: Variant[] = ["A", "B", "C"];
const scenarios: Scenario[] = [
  "Working",
  "Sign-in required",
  "Model changed",
  "Security warning",
  "Configuration",
];
const info: Record<
  Exclude<Scenario, "Working">,
  { title: string; body: string }
> = {
  "Sign-in required": {
    title: "Sign-in required",
    body: "Your session expired. Sign in to resume this task.",
  },
  "Model changed": {
    title: "Model changed · GPT-5",
    body: "This task switched to GPT-5 and is still running.",
  },
  "Security warning": {
    title: "Folder permissions need review",
    body: "Other users can change files in C:/sample/project. Review the folder permissions before continuing.",
  },
  Configuration: {
    title: "Outdated setting ignored",
    body: "The outdated setting legacy_option was ignored. Your task can continue.",
  },
};

/** Renders one simulated notice placement. */
function Notice({
  scenario,
  onRecover,
  onDetails,
  onDismiss,
}: {
  scenario: Scenario;
  onRecover: () => void;
  onDetails: () => void;
  onDismiss: () => void;
}) {
  if (scenario === "Working") return null;
  const requiresAttention =
    scenario === "Sign-in required" || scenario === "Security warning";
  const Icon = requiresAttention ? TriangleAlert : Info;
  if (scenario === "Model changed")
    return (
      <div className="flex items-center gap-2 border-b border-border px-5 py-2 text-xs text-muted-foreground">
        <Info className="size-3.5 shrink-0" aria-hidden />
        <span>{info[scenario].title}</span>
        <button
          className="rounded-md border border-border px-2 py-1 text-foreground hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onDetails}
        >
          Details
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Dismiss notice"
                className="ml-auto grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onDismiss}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            }
          />
          <TooltipContent>Hide notice</TooltipContent>
        </Tooltip>
      </div>
    );
  return (
    <div className="flex items-start gap-3 border-b border-border bg-muted/30 px-5 py-3 text-sm">
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${requiresAttention ? "text-amber-500" : "text-muted-foreground"}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{info[scenario].title}</div>
        <div className="mt-0.5 text-muted-foreground">
          {info[scenario].body}
        </div>
      </div>
      {scenario === "Sign-in required" && (
        <button
          className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onRecover}
        >
          Sign in
        </button>
      )}
      {scenario === "Security warning" && (
        <button
          className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onDetails}
        >
          Review details
        </button>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Dismiss notice"
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onDismiss}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          }
        />
        <TooltipContent>Hide notice</TooltipContent>
      </Tooltip>
    </div>
  );
}

function readVariant(value: string | null): Variant {
  return variants.includes(value as Variant) ? (value as Variant) : "B";
}

function isDetailsVisible(
  dismissed: boolean,
  detailsOpen: boolean,
  scenario: Scenario,
) {
  return !dismissed && detailsOpen && scenario !== "Working";
}

function getDetails(scenario: Scenario) {
  return scenario === "Working"
    ? { title: "No active notices", body: "The simulated turn is working." }
    : info[scenario];
}

function getModelName(scenario: Scenario) {
  return scenario === "Model changed" ? "GPT-5" : "Auto";
}

/** Throwaway local-only notice UI prototype. */
export function NoticePrototype() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const initialVariant = readVariant(params.get("variant"));
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [scenario, setScenario] = useState<Scenario>(() =>
    initialVariant === "B" ? "Security warning" : "Working",
  );
  const [occurrences, setOccurrences] = useState(() =>
    initialVariant === "B" ? 1 : 0,
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const changeVariant = (next: Variant) => {
    setVariant(next);
    const url = new URL(window.location.href);
    url.searchParams.set("variant", next);
    window.history.replaceState(null, "", url);
  };
  const recover = () => {
    setScenario("Working");
    setOccurrences(0);
    setDetailsOpen(false);
    setDismissed(false);
  };
  const chooseScenario = (next: Scenario) => {
    if (next === scenario) return;
    setScenario(next);
    setOccurrences(next === "Working" ? 0 : 1);
    setDetailsOpen(false);
    setDismissed(false);
  };
  const repeatEvent = () => {
    if (scenario !== "Working") setOccurrences((count) => count + 1);
  };
  const openDetails = () => {
    if (scenario === "Working") return;
    setDismissed(false);
    setDetailsOpen(true);
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      )
        return;
      if (event.target instanceof HTMLElement && event.target.isContentEditable)
        return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = variants.indexOf(variant);
      changeVariant(
        variants[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3],
      );
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [variant]);
  const details = getDetails(scenario);
  const showDetails = isDetailsVisible(dismissed, detailsOpen, scenario);
  const detailPanel = (
    <InlineDetails
      visible={showDetails}
      details={details}
      onClose={() => setDetailsOpen(false)}
    />
  );
  const notice = (
    <Notice
      scenario={scenario}
      onRecover={recover}
      onDetails={openDetails}
      onDismiss={() => setDismissed(true)}
    />
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <PrototypeHeader
        scenario={scenario}
        occurrences={occurrences}
        onScenarioChange={chooseScenario}
        onOpenDetails={openDetails}
        onRepeatEvent={repeatEvent}
        onRecover={recover}
      />
      <div className="flex min-h-0 flex-1">
        <main className="mx-auto flex w-full max-w-[84rem] min-w-0 flex-col px-5 py-8 pb-[70px]">
          {variant === "C" && !dismissed && notice}
          <div className="space-y-5">
            <div className="ml-auto max-w-[80%] rounded-2xl bg-muted px-4 py-3 text-sm">
              Review the latest changes
            </div>
            <div className="max-w-[80%] text-sm">
              I will check the changed files and report what needs attention.
            </div>
          </div>
          {variant === "A" && !dismissed && notice}
          {variant === "A" && detailPanel}
          {variant === "C" && <div className="lg:hidden">{detailPanel}</div>}
          <div className="mt-auto pt-10">
            {variant === "B" ? (
              <NoticePrototypeComposer
                title={details.title}
                body={details.body}
                scenario={scenario}
                detailsOpen={detailsOpen}
                dismissed={dismissed}
                onDetailsChange={setDetailsOpen}
                onRecover={recover}
                onDismiss={() => setDismissed(true)}
                onReopen={openDetails}
              />
            ) : (
              <div className="mt-3 rounded-xl border border-border bg-background p-3 shadow-sm">
                <textarea
                  aria-label="Simulated Composer"
                  placeholder="Message the agent..."
                  className="min-h-16 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                <div className="flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
                  <span>
                    Model · {getModelName(scenario)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </main>
        {variant === "C" && showDetails && (
          <div className="hidden w-64 shrink-0 border-l border-border bg-muted/10 p-5 lg:block">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Details
            </div>
            <div className="mt-3 text-sm">{details.title}</div>
            <div className="mt-2 text-xs text-muted-foreground">
              {details.body}
            </div>
            <button
              className="mt-3 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setDetailsOpen(false)}
            >
              Close details
            </button>
          </div>
        )}
      </div>
      <VariantNavigator variant={variant} onChange={changeVariant} />
    </div>
  );
}

function InlineDetails({
  visible,
  details,
  onClose,
}: {
  visible: boolean;
  details: { title: string; body: string };
  onClose: () => void;
}) {
  if (!visible) return null;
  return (
    <aside className="mt-4 rounded-lg border border-border bg-muted/20 p-4 text-sm">
      <div className="font-medium">{details.title}</div>
      <p className="mt-1 text-muted-foreground">{details.body}</p>
      <button
        className="mt-3 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onClose}
      >
        Close details
      </button>
    </aside>
  );
}

function PrototypeHeader({
  scenario,
  occurrences,
  onScenarioChange,
  onOpenDetails,
  onRepeatEvent,
  onRecover,
}: {
  scenario: Scenario;
  occurrences: number;
  onScenarioChange: (scenario: Scenario) => void;
  onOpenDetails: () => void;
  onRepeatEvent: () => void;
  onRecover: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
      <span className="text-sm font-semibold">
        Notice prototype{" "}
        <span className="font-normal text-muted-foreground">· simulated</span>
      </span>
      <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        Scenario{" "}
        <select
          value={scenario}
          onChange={(event) => onScenarioChange(event.target.value as Scenario)}
          className="rounded-md border border-border bg-background px-2 py-1 text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {scenarios.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <button
        disabled={scenario === "Working"}
        className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpenDetails}
      >
        Diagnostics
      </button>
      <details className="basis-full text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer rounded-md px-2 py-1 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          Demo controls
        </summary>
        <div className="flex flex-wrap items-center gap-3 px-2 pb-1 pt-2">
          <button
            disabled={scenario === "Working"}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onRepeatEvent}
          >
            Repeat event
          </button>
          <button
            disabled={scenario === "Working"}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onRecover}
          >
            Simulate recovery
          </button>
          <span>
            State: {scenario === "Sign-in required" ? "paused" : "working"} · Notices: {scenario === "Working" ? 0 : 1} · Occurrences: {occurrences}
          </span>
          <span>Type / to try the sample commands.</span>
        </div>
      </details>
    </div>
  );
}

function VariantNavigator({
  variant,
  onChange,
}: {
  variant: Variant;
  onChange: (variant: Variant) => void;
}) {
  return (
    <div className="fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/95 px-2 py-1.5 text-xs shadow-lg">
      <button
        className="rounded-full px-2 py-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() =>
          onChange(variant === "A" ? "C" : variant === "B" ? "A" : "B")
        }
      >
        ←
      </button>
      <button
        aria-pressed={variant === "A"}
        className={`rounded-full px-2 py-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${variant === "A" ? "bg-muted font-semibold underline underline-offset-4" : ""}`}
        onClick={() => onChange("A")}
      >
        A · Turn
      </button>
      <button
        aria-pressed={variant === "B"}
        className={`rounded-full px-2 py-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${variant === "B" ? "bg-muted font-semibold underline underline-offset-4" : ""}`}
        onClick={() => onChange("B")}
      >
        B · Composer
      </button>
      <button
        aria-pressed={variant === "C"}
        className={`rounded-full px-2 py-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${variant === "C" ? "bg-muted font-semibold underline underline-offset-4" : ""}`}
        onClick={() => onChange("C")}
      >
        C · Header
      </button>
      <button
        className="rounded-full px-2 py-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() =>
          onChange(variant === "A" ? "B" : variant === "B" ? "C" : "A")
        }
      >
        →
      </button>
    </div>
  );
}
