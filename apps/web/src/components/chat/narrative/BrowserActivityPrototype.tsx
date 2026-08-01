import { useId, useMemo, useState } from "react";
import {
  ChevronRight,
  Pencil,
  ShieldAlert,
  SquareMousePointer,
} from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { Button } from "@/components/ui/button";
import { NarrativeSummaryLine } from "./ToolSummaryLine";
import { NARRATIVE_TOOL_ROW } from "./narrative-layout";

type StepKind = "browser" | "edit" | "privileged";

interface ActivityStep {
  label: string;
  kind?: StepKind;
  output?: string;
}

interface ActivityRow {
  id: string;
  phase?: string;
  collapsedLabel: string;
  steps: readonly ActivityStep[];
}

interface PrototypeScenario {
  key: string;
  shortLabel: string;
  title: string;
  description: string;
  rows: readonly ActivityRow[];
}

const SCENARIOS: readonly PrototypeScenario[] = [
  {
    key: "single",
    shortLabel: "Open",
    title: "One Browser call",
    description: "Live and persisted rows use the same compact grammar. Only the tense changes.",
    rows: [
      {
        id: "open-live",
        phase: "Live",
        collapsedLabel: "Using the browser",
        steps: [
          { label: "Opening Checkout" },
          { label: "Waiting for navigation" },
        ],
      },
      {
        id: "open-persisted",
        phase: "After persistence",
        collapsedLabel: "Used the browser",
        steps: [{ label: "Opened Checkout", output: "Title: Checkout\nPath: /checkout" }],
      },
    ],
  },
  {
    key: "batch",
    shortLabel: "Batch",
    title: "A partial Browser batch",
    description: "The collapsed row stays quiet. Expansion shows completed actions and the stopping point.",
    rows: [
      {
        id: "batch-partial",
        collapsedLabel: "Used the browser",
        steps: [
          { label: "Selected delivery", output: "Selection completed" },
          { label: "Waited for total", output: "Condition satisfied: total settled" },
          {
            label: "Stopped at action 3 of 4 when the total changed",
            output: "Action 3 was not run because the page changed.",
          },
        ],
      },
    ],
  },
  {
    key: "takeover",
    shortLabel: "Takeover",
    title: "The user takes control",
    description: "The aggregate remains a Browser action. Expansion explains the control transfer without a generic error block.",
    rows: [
      {
        id: "takeover-interrupted",
        collapsedLabel: "Used the browser",
        steps: [{ label: "Stopped when you took control", output: "User control detected. Browser action stopped." }],
      },
    ],
  },
  {
    key: "recovery",
    shortLabel: "Recovery",
    title: "A blocked Browser action",
    description: "Expansion shows what stopped the action.",
    rows: [
      {
        id: "recovery-blocked",
        collapsedLabel: "Used the browser",
        steps: [{ label: "Page changed before the action", output: "The Browser target changed before the action could run." }],
      },
    ],
  },
  {
    key: "evaluate",
    shortLabel: "Evaluate",
    title: "A privileged Browser evaluation",
    description: "The default row stays ordinary. Expansion names the privilege boundary without exposing code or results.",
    rows: [
      {
        id: "evaluate-completed",
        collapsedLabel: "Used the browser",
        steps: [
          {
            label: "Evaluated Checkout · Privileged",
            kind: "privileged",
            output: "Title: Checkout\nState: interactive",
          },
        ],
      },
    ],
  },
  {
    key: "grouped",
    shortLabel: "Grouped",
    title: "Browser work beside other tools",
    description: "The aggregate reads like the existing narrative. Expansion restores the chronological actions.",
    rows: [
      {
        id: "grouped-completed",
        collapsedLabel: "Used the browser, edited a file",
        steps: [
          { label: "Opened Checkout", output: "Title: Checkout\nPath: /checkout" },
          { label: "Inspected Checkout", output: "Heading: Checkout\nButton: Continue" },
          { label: "Completed 2 Browser actions", output: "Both Browser actions completed." },
          { label: "Edited BrowserActivityPrototype.tsx", kind: "edit" },
        ],
      },
    ],
  },
] as const;

function readScenarioKey(): string {
  return new URLSearchParams(window.location.search).get("browserActivityScenario") ?? SCENARIOS[0]!.key;
}

function replaceScenarioParam(scenarioKey: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("browserActivityScenario", scenarioKey);
  window.history.replaceState(null, "", url);
}

function StepIcon({ kind = "browser" }: { kind?: StepKind }) {
  if (kind === "edit") {
    return <Pencil className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
  if (kind === "privileged") {
    return <ShieldAlert className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
  return <SquareMousePointer className="size-3.5 shrink-0 text-muted-foreground/75" aria-hidden="true" />;
}

function BrowserActivityStep({ step }: { step: ActivityStep }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  if (!step.output) {
    return (
      <div className={`${NARRATIVE_TOOL_ROW} py-1 text-sm`}>
        <StepIcon kind={step.kind} />
        <span className="min-w-0 flex-1 font-medium text-foreground/65">{step.label}</span>
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((current) => !current)}
        className={`${NARRATIVE_TOOL_ROW} h-auto w-full justify-start rounded-md px-0 py-1 text-left font-normal transition-colors duration-150 hover:bg-muted/30 aria-expanded:bg-transparent active:translate-y-0 motion-reduce:transition-none dark:hover:bg-muted/30 dark:aria-expanded:bg-transparent`}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <StepIcon kind={step.kind} />
        <span className="min-w-0 flex-1 font-medium text-foreground/65">{step.label}</span>
        <ChevronRight
          className={`size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
      </Button>

      <AnimatedCollapsible open={open}>
        <section
          id={panelId}
          aria-label={`${step.label} result`}
          className="ml-5 mt-1 min-w-0 max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted/25"
        >
          <header className="border-b border-border/50 px-3 py-2 text-sm font-medium text-foreground/75">
            Plain text
          </header>
          <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs leading-5 text-foreground/75 [overflow-wrap:anywhere]">
            {step.output}
          </pre>
        </section>
      </AnimatedCollapsible>
    </div>
  );
}

function CompactActivityRow({ row }: { row: ActivityRow }) {
  const [open, setOpen] = useState(false);
  const detailsId = `browser-activity-details-${row.id}`;

  return (
    <div className="min-w-0">
      {row.phase ? <p className="mb-1 pl-7 text-xs text-muted-foreground">{row.phase}</p> : null}
      <NarrativeSummaryLine
        open={open}
        onToggle={() => setOpen((current) => !current)}
        icon={<SquareMousePointer className="size-4 shrink-0 text-muted-foreground/55" aria-hidden="true" />}
      >
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/75">{row.collapsedLabel}</span>
      </NarrativeSummaryLine>

      <AnimatedCollapsible open={open}>
        <div id={detailsId}>
          <ul className="mt-1 min-w-0 max-w-full space-y-1 pb-2 pl-6" aria-label={`${row.collapsedLabel} details`}>
            {row.steps.map((step) => (
              <li key={`${row.id}-${step.label}`} className="min-w-0 max-w-full py-1 text-sm">
                <BrowserActivityStep step={step} />
              </li>
            ))}
          </ul>
        </div>
      </AnimatedCollapsible>
    </div>
  );
}

/** Renders the development-only compact Browser narrative prototype. */
export function BrowserActivityPrototype() {
  const [scenarioKey, setScenarioKey] = useState(readScenarioKey);
  const scenario = useMemo(
    () => SCENARIOS.find((candidate) => candidate.key === scenarioKey) ?? SCENARIOS[0]!,
    [scenarioKey],
  );

  const changeScenario = (nextScenarioKey: string) => {
    setScenarioKey(nextScenarioKey);
    replaceScenarioParam(nextScenarioKey);
  };

  return (
    <div className="flex h-full flex-col bg-background" data-testid="browser-activity-prototype">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <SquareMousePointer className="size-4 text-muted-foreground" aria-hidden="true" />
        <p className="truncate text-sm font-medium text-foreground">Browser activity prototype</p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto w-full max-w-3xl">
          <div className="rounded-xl bg-muted/20 px-4 py-3 text-sm text-foreground/90">
            Check the checkout flow in the Browser. Stop if I take control.
          </div>

          <section className="mt-8" aria-labelledby="browser-prototype-heading">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Compact narrative line</p>
            <h1 id="browser-prototype-heading" className="mt-1 text-xl font-semibold text-foreground">{scenario.title}</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{scenario.description}</p>

            <div className="mt-5 flex flex-wrap gap-1" role="group" aria-label="Browser activity scenario">
              {SCENARIOS.map((candidate) => (
                <Button
                  key={candidate.key}
                  type="button"
                  variant={candidate.key === scenario.key ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={candidate.key === scenario.key}
                  onClick={() => changeScenario(candidate.key)}
                >
                  {candidate.shortLabel}
                </Button>
              ))}
            </div>

            <div className="mt-6 space-y-2" aria-label={scenario.title}>
              {scenario.rows.map((row) => <CompactActivityRow key={row.id} row={row} />)}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
