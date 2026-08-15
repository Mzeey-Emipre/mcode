import { useId, useState, type ReactNode } from "react";
import { ChevronRight, ShieldAlert, SquareMousePointer } from "lucide-react";
import {
  projectBrowserNarrativeInput,
  projectBrowserNarrativeResult,
  resolveBrowserNarrativeTool,
  type BrowserNarrativeReceipt,
  type BrowserNarrativeResult,
  type BrowserNarrativeStepInput,
} from "@mcode/contracts";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { Button } from "@/components/ui/button";
import type { ToolCall } from "@/transport/types";
import { buildToolSummaryText } from "@/components/chat/tool-renderers/constants";
import { NARRATIVE_TOOL_ROW } from "./narrative-layout";
import { NarrativeSummaryLine } from "./NarrativeSummaryLine";

interface BrowserActivitySummaryProps {
  calls: readonly ToolCall[];
  active?: boolean;
  renderOtherCall?: (toolCall: ToolCall) => ReactNode;
}

interface BrowserActivityCallProps {
  toolCall: ToolCall;
  active?: boolean;
}

interface BrowserActivityLine {
  key: string;
  label: string;
  receipt?: string;
  privileged?: boolean;
}

const ACTIVE_ACTION_LABELS: Record<string, string> = {
  navigate: "Navigating the page",
  back: "Going back",
  forward: "Going forward",
  reload: "Reloading the page",
  resize: "Resizing the Browser",
  hover: "Hovering over the page",
  click: "Clicking the page",
  drag: "Dragging on the page",
  type: "Entering text",
  press: "Pressing a key",
  scroll: "Scrolling the page",
  wait: "Waiting for the page",
  assert: "Checking the page",
  recordingStart: "Starting a page recording",
  recordingStop: "Stopping the page recording",
};

const COMPLETED_ACTION_LABELS: Record<string, string> = {
  navigate: "Navigated the page",
  back: "Went back",
  forward: "Went forward",
  reload: "Reloaded the page",
  resize: "Resized the Browser",
  hover: "Hovered over the page",
  click: "Clicked the page",
  drag: "Dragged on the page",
  type: "Entered text",
  press: "Pressed a key",
  scroll: "Scrolled the page",
  wait: "Waited for the page",
  assert: "Checked the page",
  recordingStart: "Started a page recording",
  recordingStop: "Stopped the page recording",
};

/** Returns true when a tool call belongs to the Browser v2 narrative surface. */
export function isBrowserNarrativeCall(toolCall: Pick<ToolCall, "toolName">): boolean {
  return resolveBrowserNarrativeTool(toolCall.toolName) !== null;
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toLowerCase()}${value.slice(1)}`;
}

function naturalizeSingleCount(value: string): string {
  return value
    .replace(/^edited 1 file$/, "edited a file")
    .replace(/^created 1 file$/, "created a file")
    .replace(/^read 1 file$/, "read a file")
    .replace(/^ran 1 command$/, "ran a command");
}

/** Builds the accepted collapsed summary for a Browser-containing tool group. */
export function buildBrowserActivitySummary(calls: readonly ToolCall[], active: boolean): string {
  const prefix = active ? "Using the browser" : "Used the browser";
  const otherCalls = calls.filter((call) => !isBrowserNarrativeCall(call));
  if (otherCalls.length === 0) return prefix;
  const otherSummary = buildToolSummaryText(otherCalls);
  return `${prefix}, ${naturalizeSingleCount(lowerFirst(otherSummary))}`;
}

function safeInput(toolCall: ToolCall) {
  return projectBrowserNarrativeInput(toolCall.toolName, toolCall.toolInput);
}

function safeResult(toolCall: ToolCall): BrowserNarrativeResult | null {
  if (!toolCall.output) return null;
  return projectBrowserNarrativeResult(toolCall.toolName, toolCall.output, toolCall.isError);
}

function resizeSuffix(step: BrowserNarrativeStepInput | undefined): string {
  if (step?.operation !== "resize" || step.width === undefined || step.height === undefined) return "";
  return ` to ${step.width} × ${step.height}`;
}

function receiptText(
  result: BrowserNarrativeResult,
  receipt?: BrowserNarrativeReceipt,
): string {
  const lines = [
    "MCP server: mcode-browser",
    `MCP tool: ${result.operation}`,
    `Outcome: ${result.outcome}`,
  ];
  if (result.effect) lines.push(`Effect: ${result.effect}`);
  if (result.recovery) lines.push(`Recovery: ${result.recovery}`);
  if (result.errorCode) lines.push(`Error code: ${result.errorCode}`);
  if (result.readiness) lines.push(`Readiness: ${result.readiness}`);
  if (result.tabCount !== undefined) lines.push(`Tabs: ${result.tabCount}`);
  if (result.capabilityCount !== undefined) lines.push(`Capabilities: ${result.capabilityCount}`);
  if (receipt) {
    lines.push(`Action ${receipt.index + 1}: ${receipt.operation}`);
    lines.push(`Status: ${receipt.status}`);
  }
  return lines.join("\n");
}

function interruptedLabel(
  result: BrowserNarrativeResult,
  receipt: BrowserNarrativeReceipt,
  total: number,
): string {
  if (result.recovery === "yield_to_user") return "Stopped when you took control";
  return `Stopped at action ${receipt.index + 1} of ${total}`;
}

function receiptLabel(
  result: BrowserNarrativeResult,
  receipt: BrowserNarrativeReceipt,
  step: BrowserNarrativeStepInput | undefined,
  total: number,
): string {
  if (receipt.status === "interrupted") return interruptedLabel(result, receipt, total);
  if (receipt.status === "failed") return `Stopped at action ${receipt.index + 1} of ${total}`;
  if (receipt.status === "skipped") return `Skipped action ${receipt.index + 1} of ${total}`;
  return `${COMPLETED_ACTION_LABELS[receipt.operation] ?? "Completed a Browser action"}${resizeSuffix(step)}`;
}

function failedToolLabel(
  result: BrowserNarrativeResult | null,
  cancelled: boolean,
): string | null {
  if (cancelled) return "Browser action cancelled";
  if (!result || result.outcome === "completed") return null;
  if (result.recovery === "yield_to_user" || result.errorCode === "HUMAN_INTERRUPTED") {
    return "Stopped when you took control";
  }
  if (["STALE_TARGET_GENERATION", "CAPABILITY_CHANGED", "STALE_CONTROL_EPOCH"].includes(result.errorCode ?? "")) {
    return "Page changed before the action";
  }
  if (["TAB_UNAVAILABLE", "HOST_UNAVAILABLE"].includes(result.errorCode ?? "")) {
    return "Browser became unavailable";
  }
  if (["TIMEOUT", "DEADLINE_EXCEEDED"].includes(result.errorCode ?? "")) {
    return "Browser action timed out";
  }
  return result.outcome === "interrupted" ? "Browser action stopped" : "Browser action failed";
}

function toolLabel(toolCall: ToolCall, active: boolean, result: BrowserNarrativeResult | null): string {
  const failureLabel = failedToolLabel(result, toolCall.isCancelled === true);
  if (!active && failureLabel) return failureLabel;
  const operation = resolveBrowserNarrativeTool(toolCall.toolName);
  const input = safeInput(toolCall);
  const action = input?.action;
  const granularStep = operation === "browser_act" ? undefined : input?.steps?.[0];
  if (granularStep) {
    const labels = active ? ACTIVE_ACTION_LABELS : COMPLETED_ACTION_LABELS;
    return `${labels[granularStep.operation] ?? (active ? "Using the Browser" : "Completed a Browser action")}${resizeSuffix(granularStep)}`;
  }
  if (operation === "browser_open") return active ? "Opening a page" : "Opened a page";
  if (operation === "browser_inspect") return active ? "Inspecting the page" : "Inspected the page";
  if (operation === "browser_act") return active ? "Acting on the page" : "Acted on the page";
  if (operation === "browser_evaluate") return active ? "Evaluating the page · Privileged" : "Evaluated the page · Privileged";
  if (operation === "browser_tabs") {
    const labels: Record<string, [string, string]> = {
      select: ["Selecting a Browser tab", "Selected a Browser tab"],
      claim: ["Claiming a Browser tab", "Claimed a Browser tab"],
      release: ["Releasing a Browser tab", "Released a Browser tab"],
      close: ["Closing a Browser tab", "Closed a Browser tab"],
      finalize: ["Finalizing Browser tabs", "Finalized Browser tabs"],
    };
    return action ? labels[action]?.[active ? 0 : 1] ?? "Updated Browser tabs" : "Updated Browser tabs";
  }
  return active ? "Using the Browser" : "Completed Browser actions";
}

function buildActivityLines(toolCall: ToolCall, active: boolean): BrowserActivityLine[] {
  const input = safeInput(toolCall);
  const result = safeResult(toolCall);
  const privileged = input?.operation === "browser_evaluate";

  if (!active && result?.receipts && result.receipts.length > 0) {
    return result.receipts.map((receipt) => ({
      key: `${toolCall.id}-${receipt.index}`,
      label: receiptLabel(result, receipt, input?.steps?.[receipt.index], result.receipts!.length),
      receipt: receiptText(result, receipt),
      privileged,
    }));
  }

  if (active && input?.steps && input.steps.length > 0) {
    return input.steps.map((step, index) => ({
      key: `${toolCall.id}-${index}`,
      label: `${ACTIVE_ACTION_LABELS[step.operation] ?? "Using the Browser"}${resizeSuffix(step)}`,
      privileged,
    }));
  }

  return [{
    key: toolCall.id,
    label: toolLabel(toolCall, active, result),
    ...(result ? { receipt: receiptText(result) } : {}),
    privileged,
  }];
}

function BrowserActivityLineRow({ line }: { line: BrowserActivityLine }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const Icon = line.privileged ? ShieldAlert : SquareMousePointer;

  if (!line.receipt) {
    return (
      <div className={`${NARRATIVE_TOOL_ROW} py-1 text-sm`}>
        <Icon className="size-3.5 shrink-0 text-muted-foreground/75" aria-hidden="true" />
        <span className="min-w-0 flex-1 font-medium text-foreground/65">{line.label}</span>
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
        className={`${NARRATIVE_TOOL_ROW} h-auto w-full justify-start rounded-md px-0 py-1 text-left font-normal hover:bg-muted/30 aria-expanded:bg-transparent active:translate-y-0`}
        aria-expanded={open}
        aria-controls={detailsId}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground/75" aria-hidden="true" />
        <span className="min-w-0 flex-1 font-medium text-foreground/65">{line.label}</span>
        <ChevronRight
          className={`size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
      </Button>
      <AnimatedCollapsible open={open}>
        <section
          id={detailsId}
          aria-label={`${line.label} receipt`}
          className="ml-5 mt-1 min-w-0 max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted/25"
        >
          <header className="border-b border-border/50 px-3 py-2 text-sm font-medium text-foreground/75">
            Plain text
          </header>
          <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs leading-5 text-foreground/75 [overflow-wrap:anywhere]">
            {line.receipt}
          </pre>
        </section>
      </AnimatedCollapsible>
    </div>
  );
}

/** Renders one Browser tool call as chronological content-free action rows. */
export function BrowserActivityCall({ toolCall, active = false }: BrowserActivityCallProps) {
  return (
    <li className="min-w-0 max-w-full py-1">
      {buildActivityLines(toolCall, active).map((line) => (
        <BrowserActivityLineRow key={line.key} line={line} />
      ))}
    </li>
  );
}

/** Renders the accepted quiet Browser summary and its chronological action list. */
export function BrowserActivitySummary({
  calls,
  active = false,
  renderOtherCall,
}: BrowserActivitySummaryProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 max-w-full rounded-md">
      <NarrativeSummaryLine
        open={open}
        onToggle={() => setOpen((current) => !current)}
        icon={<SquareMousePointer className="size-4 shrink-0 text-muted-foreground/55" aria-hidden="true" />}
      >
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/75">
          {buildBrowserActivitySummary(calls, active)}
        </span>
      </NarrativeSummaryLine>
      <AnimatedCollapsible open={open}>
        <ul className="mt-1 min-w-0 max-w-full space-y-1 pb-2 pl-6" aria-label="Browser activity details">
          {calls.map((call) => isBrowserNarrativeCall(call)
            ? <BrowserActivityCall key={call.id} toolCall={call} active={active} />
            : renderOtherCall?.(call))}
        </ul>
      </AnimatedCollapsible>
    </div>
  );
}
