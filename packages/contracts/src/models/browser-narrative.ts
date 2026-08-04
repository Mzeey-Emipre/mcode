import { BROWSER_AUTOMATION_ACT_MAX_STEPS, BROWSER_AUTOMATION_ERROR_CODES } from "./browser-automation.js";

/** Browser v2 tools that render as first-class narrative activity. */
export const BROWSER_NARRATIVE_TOOLS = [
  "browser_status",
  "browser_open",
  "browser_navigate",
  "browser_resize",
  "browser_snapshot",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_wait_for",
  "browser_console",
  "browser_network",
  "browser_accessibility",
  "browser_performance",
  "browser_recording_start",
  "browser_recording_stop",
  "browser_inspect",
  "browser_act",
  "browser_tabs",
  "browser_evaluate",
] as const;

/** Browser v2 tool identity used by the narrative projection. */
export type BrowserNarrativeTool = (typeof BROWSER_NARRATIVE_TOOLS)[number];

/** One content-free Browser action admitted to the narrative. */
export interface BrowserNarrativeStepInput {
  operation: string;
  width?: number;
  height?: number;
}

/** Content-free Browser tool input safe for live and persisted narrative state. */
export interface BrowserNarrativeInput {
  operation: BrowserNarrativeTool;
  action?: "select" | "claim" | "release" | "close" | "finalize";
  steps?: BrowserNarrativeStepInput[];
}

/** One content-free Browser mutation receipt safe for narrative disclosure. */
export interface BrowserNarrativeReceipt {
  index: number;
  operation: string;
  status: "applied" | "satisfied" | "failed" | "interrupted" | "skipped";
}

/** Bounded Browser result safe for narrative disclosure and persistence. */
export interface BrowserNarrativeResult {
  operation: BrowserNarrativeTool;
  outcome: "completed" | "failed" | "interrupted";
  action?: "select" | "claim" | "release" | "close" | "finalize";
  effect?: string;
  recovery?: string;
  errorCode?: string;
  readiness?: "ready" | "host-unavailable" | "target-unavailable" | "recovering" | "human-control";
  receipts?: BrowserNarrativeReceipt[];
  tabCount?: number;
  capabilityCount?: number;
}

const STEP_OPERATIONS = new Set([
  "navigate",
  "back",
  "forward",
  "reload",
  "resize",
  "hover",
  "click",
  "drag",
  "type",
  "press",
  "scroll",
  "wait",
  "assert",
  "recordingStart",
  "recordingStop",
]);
const GRANULAR_STEP_OPERATIONS: Partial<Record<BrowserNarrativeTool, string>> = {
  browser_navigate: "navigate",
  browser_resize: "resize",
  browser_click: "click",
  browser_type: "type",
  browser_press: "press",
  browser_scroll: "scroll",
  browser_wait_for: "wait",
  browser_recording_start: "recordingStart",
  browser_recording_stop: "recordingStop",
};
const TAB_ACTIONS = new Set(["select", "claim", "release", "close", "finalize"]);
const OUTCOMES = new Set(["completed", "failed", "interrupted"]);
const RECEIPT_STATUSES = new Set(["applied", "satisfied", "failed", "interrupted", "skipped"]);
const EFFECTS = new Set(["none", "partial", "complete", "created", "closed", "preserved", "unknown"]);
const RECOVERIES = new Set([
  "none",
  "retry",
  "refresh",
  "reopen",
  "manual",
  "inspect",
  "wait",
  "yield_to_user",
  "do_not_retry",
]);
const READINESS_STATES = new Set([
  "ready",
  "host-unavailable",
  "target-unavailable",
  "recovering",
  "human-control",
]);
const ERROR_CODES = new Set<string>(BROWSER_AUTOMATION_ERROR_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function allowedString(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Resolves provider-specific mcode-browser names to one Browser v2 narrative tool. */
export function resolveBrowserNarrativeTool(toolName: string): BrowserNarrativeTool | null {
  const normalized = normalizedToolName(toolName);
  for (const candidate of BROWSER_NARRATIVE_TOOLS) {
    const canonicalMcpName = `mcode_browser_${candidate}`;
    if (
      normalized === candidate
      || normalized === canonicalMcpName
      || normalized.endsWith(`_${canonicalMcpName}`)
    ) return candidate;
  }
  return null;
}

function browserArguments(input: Record<string, unknown>): Record<string, unknown> {
  return isRecord(input.args) ? input.args : input;
}

function projectStep(value: unknown): BrowserNarrativeStepInput | null {
  if (!isRecord(value)) return null;
  const operation = allowedString(value.operation, STEP_OPERATIONS);
  if (!operation) return null;
  if (operation !== "resize") return { operation };

  const width = finiteInteger(value.width);
  const height = finiteInteger(value.height);
  return {
    operation,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

/** Projects raw Browser input into a content-free narrative input. */
export function projectBrowserNarrativeInput(
  toolName: string,
  input: Record<string, unknown>,
): BrowserNarrativeInput | null {
  const operation = resolveBrowserNarrativeTool(toolName);
  if (!operation) return null;
  const args = browserArguments(input);

  if (operation === "browser_act") {
    const steps = Array.isArray(args.steps)
      ? args.steps
          .slice(0, BROWSER_AUTOMATION_ACT_MAX_STEPS)
          .map(projectStep)
          .filter((step): step is BrowserNarrativeStepInput => step !== null)
      : [];
    return { operation, steps };
  }

  if (operation === "browser_tabs") {
    const action = allowedString(args.action, TAB_ACTIONS) as BrowserNarrativeInput["action"];
    return { operation, ...(action ? { action } : {}) };
  }

  const granularStepOperation = GRANULAR_STEP_OPERATIONS[operation];
  if (granularStepOperation) {
    const step = granularStepOperation === "resize"
      ? projectStep({ operation: granularStepOperation, width: args.width, height: args.height })
      : projectStep({ operation: granularStepOperation });
    return { operation, ...(step ? { steps: [step] } : {}) };
  }

  return { operation };
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;

    if (Array.isArray(parsed.content)) {
      const textBlock = parsed.content.find(
        (block): block is Record<string, unknown> => isRecord(block) && block.type === "text" && typeof block.text === "string",
      );
      if (textBlock && typeof textBlock.text === "string") return parseJsonRecord(textBlock.text);
    }
    return parsed;
  } catch {
    return null;
  }
}

function projectReceipt(value: unknown): BrowserNarrativeReceipt | null {
  if (!isRecord(value)) return null;
  const index = finiteInteger(value.index);
  const operation = allowedString(value.operation, STEP_OPERATIONS);
  const status = allowedString(value.status, RECEIPT_STATUSES) as BrowserNarrativeReceipt["status"];
  if (index === undefined || !operation || !status) return null;
  return { index, operation, status };
}

/** Projects raw Browser output into a bounded, content-free narrative receipt. */
export function projectBrowserNarrativeResult(
  toolName: string,
  output: string,
  isError: boolean,
): BrowserNarrativeResult | null {
  const operation = resolveBrowserNarrativeTool(toolName);
  if (!operation) return null;
  const raw = parseJsonRecord(output) ?? {};
  const rawOutcome = allowedString(raw.outcome, OUTCOMES) as BrowserNarrativeResult["outcome"];
  const outcome = rawOutcome ?? (isError ? "failed" : "completed");
  const effect = allowedString(raw.effect, EFFECTS);
  const recovery = allowedString(raw.recovery, RECOVERIES);
  const errorCode = allowedString(raw.code, ERROR_CODES);
  const action = operation === "browser_tabs"
    ? allowedString(raw.action, TAB_ACTIONS) as BrowserNarrativeResult["action"]
    : undefined;
  const readinessRecord = isRecord(raw.readiness) ? raw.readiness : null;
  const readiness = operation === "browser_inspect"
    ? allowedString(readinessRecord?.state, READINESS_STATES) as BrowserNarrativeResult["readiness"]
    : undefined;
  const receipts = operation === "browser_act" && Array.isArray(raw.receipts)
    ? raw.receipts
        .slice(0, BROWSER_AUTOMATION_ACT_MAX_STEPS)
        .map(projectReceipt)
        .filter((receipt): receipt is BrowserNarrativeReceipt => receipt !== null)
    : [];
  const tabCount = (operation === "browser_tabs" || operation === "browser_inspect")
    && Array.isArray(raw.tabs)
    ? raw.tabs.length
    : undefined;
  const capabilityCount = operation === "browser_inspect" && Array.isArray(raw.capabilities)
    ? raw.capabilities.length
    : undefined;

  return {
    operation,
    outcome,
    ...(action ? { action } : {}),
    ...(effect ? { effect } : {}),
    ...(recovery ? { recovery } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(readiness ? { readiness } : {}),
    ...(receipts.length > 0 ? { receipts } : {}),
    ...(tabCount === undefined ? {} : { tabCount }),
    ...(capabilityCount === undefined ? {} : { capabilityCount }),
  };
}

/** Serializes a Browser narrative result without exposing the raw MCP result. */
export function serializeBrowserNarrativeResult(result: BrowserNarrativeResult): string {
  return JSON.stringify(result);
}
