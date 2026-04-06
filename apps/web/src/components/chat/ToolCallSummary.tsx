import { useState, useCallback, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { getTransport } from "@/transport";
import { useThreadStore } from "@/stores/threadStore";
import { SubagentContainer } from "./tool-renderers/SubagentContainer";
import { TOOL_LABELS, TOOL_ICONS, DEFAULT_ICON } from "./tool-renderers/constants";
import type { ToolCallRecord } from "@/transport/types";

/** How many steps to show before collapsing behind "+N more". */
const VISIBLE_LIMIT = 4;

/** Props for the ToolCallSummary component. */
interface ToolCallSummaryProps {
  messageId: string;
  toolCallCount: number;
}

/** A logical step: a group of same-type tool calls or a single Agent call. */
interface Step {
  type: "group" | "agent";
  toolName: string;
  label: string;
  records: ToolCallRecord[];
}

/** Group top-level records into logical steps. */
function buildSteps(records: ToolCallRecord[]): Step[] {
  const topLevel = records.filter((r) => !r.parent_tool_call_id);
  const steps: Step[] = [];

  let pending: Step | null = null;
  const flush = () => {
    if (pending) {
      steps.push(pending);
      pending = null;
    }
  };

  for (const r of topLevel) {
    if (r.tool_name === "Agent") {
      flush();
      steps.push({
        type: "agent",
        toolName: "Agent",
        label: r.input_summary || "Delegated task",
        records: [r],
      });
    } else {
      if (pending && pending.toolName === r.tool_name) {
        pending.records.push(r);
      } else {
        flush();
        const label = TOOL_LABELS[r.tool_name] ?? r.tool_name;
        pending = { type: "group", toolName: r.tool_name, label, records: [r] };
      }
    }
  }
  flush();
  return steps;
}

/** Non-expandable row for a single persisted tool call record. */
function RecordRow({ record }: { record: ToolCallRecord }) {
  const Icon = TOOL_ICONS[record.tool_name] ?? DEFAULT_ICON;
  const label = TOOL_LABELS[record.tool_name] ?? record.tool_name;

  return (
    <div className="flex items-center gap-2 rounded-md pl-3 pr-1 py-1 text-xs transition-colors hover:bg-muted/20">
      <Icon size={13} className="shrink-0 text-muted-foreground" />
      <span className="font-medium text-foreground/80">{label}</span>
      {record.input_summary && (
        <span className="min-w-0 truncate text-xs text-muted-foreground/70 font-mono">
          {record.input_summary}
        </span>
      )}
    </div>
  );
}

/** A single step row within the summary. */
function StepRow({ step }: { step: Step }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = TOOL_ICONS[step.toolName] ?? DEFAULT_ICON;
  const count = step.records.length;

  if (step.type === "agent") {
    const r = step.records[0];
    return (
      <SubagentContainer
        toolCallId={r.id}
        description={r.input_summary}
        status={r.status as "completed" | "failed" | "running"}
      />
    );
  }

  // Single call: non-expandable row with input_summary as badge
  if (count === 1) {
    return <RecordRow record={step.records[0]} />;
  }

  // Multi-call group: expands to show individual record rows
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="flex w-full items-center gap-2 rounded-md pl-3 pr-1 py-1 text-left text-xs cursor-pointer hover:bg-muted/20 transition-colors"
      >
        <Icon size={13} className="shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground/80 dark:text-foreground/70">{step.label}</span>
        <span className="text-xs text-muted-foreground/70">({count})</span>
        <ChevronRight
          size={11}
          className={`ml-auto shrink-0 text-muted-foreground/70 transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </button>
      {expanded && (
        <div className="pl-4 max-h-[300px] overflow-y-auto scrollbar-on-hover">
          {step.records.map((r) => (
            <RecordRow key={r.id} record={r} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Collapsed post-turn summary. Perplexity-style progressive disclosure. */
export function ToolCallSummary({ messageId, toolCallCount }: ToolCallSummaryProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [records, setRecords] = useState<ToolCallRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const steps = records ? buildSteps(records) : null;
  const stepCount = steps?.length ?? 0;
  const hasOverflow = stepCount > VISIBLE_LIMIT;
  const visibleSteps = steps
    ? showAll
      ? steps
      : steps.slice(0, VISIBLE_LIMIT)
    : null;
  const hiddenCount = stepCount - VISIBLE_LIMIT;

  const handleToggle = useCallback(async () => {
    if (!expanded && records === null) {
      const cached = useThreadStore.getState().getCachedToolCallRecords(messageId);
      if (cached) {
        setRecords(cached);
      } else {
        setLoading(true);
        try {
          const loaded = await getTransport().listToolCallRecords(messageId);
          if (!mountedRef.current) return;
          setRecords(loaded);
          useThreadStore.getState().cacheToolCallRecords(messageId, loaded);
        } catch {
          if (!mountedRef.current) return;
          setRecords([]);
        } finally {
          if (mountedRef.current) setLoading(false);
        }
      }
    }
    setExpanded((prev) => {
      if (prev) setShowAll(false); // reset when collapsing
      return !prev;
    });
  }, [expanded, records, messageId]);

  // Top-level label: before load show tool count, after load show step count
  const topLabel = steps
    ? `Completed ${stepCount} step${stepCount !== 1 ? "s" : ""}`
    : `Completed ${toolCallCount} action${toolCallCount !== 1 ? "s" : ""}`;

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={expanded}
        className="group flex items-center gap-1.5 py-1 text-xs text-muted-foreground transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary rounded-sm"
      >
        <ChevronDown
          size={12}
          className={`shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`}
        />
        <span>{topLabel}</span>
        {loading && <span className="text-xs text-muted-foreground/70 ml-1">...</span>}
      </button>

      {expanded && visibleSteps && visibleSteps.length > 0 && (
        <div className="relative mt-0.5 flex flex-col gap-px max-h-[60vh] overflow-y-auto scrollbar-on-hover">
          {/* Single continuous gradient line aligned with the chevron */}
          <div className="absolute left-[5px] top-0 bottom-0 w-px bg-gradient-to-b from-border/30 to-transparent" />
          <div className="pl-4">
            {visibleSteps.map((step, i) => (
              <StepRow key={step.records[0]?.id ?? `step-${i}`} step={step} />
            ))}

            {hasOverflow && (
              <button
                type="button"
                onClick={() => setShowAll((p) => !p)}
                className="py-1.5 pl-3 text-xs text-muted-foreground/70 hover:text-muted-foreground transition-colors cursor-pointer"
              >
                {showAll ? "Show less" : `+${hiddenCount} more`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
