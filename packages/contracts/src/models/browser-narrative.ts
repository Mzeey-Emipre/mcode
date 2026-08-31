import { BROWSER_AUTOMATION_ACT_MAX_STEPS, BROWSER_AUTOMATION_ERROR_CODES } from "./browser-automation.js";

/** Browser v2 tools that render as first-class narrative activity. */
export const BROWSER_NARRATIVE_TOOLS = [
  "browser_open",
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
  const error = isRecord(raw.error) ? raw.error : raw;
  const result: BrowserNarrativeResult = { operation, outcome: projectOutcome(raw, isError) };
  assignCommonResultFields(result, raw, error);
  assignOperationResultFields(result, operation, raw);
  return result;
}

function projectOutcome(raw: Record<string, unknown>, isError: boolean): BrowserNarrativeResult["outcome"] {
  const outcome = allowedString(raw.outcome, OUTCOMES) as BrowserNarrativeResult["outcome"];
  return outcome ?? (isError || isRecord(raw.error) ? "failed" : "completed");
}

function assignCommonResultFields(
  result: BrowserNarrativeResult,
  raw: Record<string, unknown>,
  error: Record<string, unknown>,
): void {
  assignResultField(result, "effect", allowedString(raw.effect, EFFECTS) ?? allowedString(error.effect, EFFECTS));
  assignResultField(result, "recovery", allowedString(raw.recovery, RECOVERIES) ?? allowedString(error.recovery, RECOVERIES));
  assignResultField(result, "errorCode", allowedString(raw.code, ERROR_CODES) ?? allowedString(error.code, ERROR_CODES));
}

function assignOperationResultFields(
  result: BrowserNarrativeResult,
  operation: BrowserNarrativeTool,
  raw: Record<string, unknown>,
): void {
  if (operation === "browser_tabs") assignResultField(result, "action", allowedString(raw.action, TAB_ACTIONS));
  if (operation === "browser_inspect") assignInspectionResultFields(result, raw);
  if (operation === "browser_act") assignActionReceipts(result, raw);
}

function assignInspectionResultFields(result: BrowserNarrativeResult, raw: Record<string, unknown>): void {
  const readiness = isRecord(raw.readiness) ? allowedString(raw.readiness.state, READINESS_STATES) : undefined;
  assignResultField(result, "readiness", readiness);
  assignResultField(result, "tabCount", Array.isArray(raw.tabs) ? raw.tabs.length : undefined);
  assignResultField(result, "capabilityCount", Array.isArray(raw.capabilities) ? raw.capabilities.length : undefined);
}

function assignActionReceipts(result: BrowserNarrativeResult, raw: Record<string, unknown>): void {
  if (!Array.isArray(raw.receipts)) return;
  const receipts = raw.receipts
    .slice(0, BROWSER_AUTOMATION_ACT_MAX_STEPS)
    .map(projectReceipt)
    .filter((receipt): receipt is BrowserNarrativeReceipt => receipt !== null);
  if (receipts.length > 0) result.receipts = receipts;
}

function assignResultField(
  result: BrowserNarrativeResult,
  field: "action" | "effect" | "recovery" | "errorCode" | "readiness" | "tabCount" | "capabilityCount",
  value: string | number | undefined,
): void {
  if (value !== undefined) Object.assign(result, { [field]: value });
}

/** Serializes a Browser narrative result without exposing the raw MCP result. */
export function serializeBrowserNarrativeResult(result: BrowserNarrativeResult): string {
  return JSON.stringify(result);
}
