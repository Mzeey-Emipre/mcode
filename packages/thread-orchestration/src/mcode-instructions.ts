/** Capability-derived runtime guidance shared by every provider adapter. */

import { MCODE_BROWSER_GUIDE } from "./browser-operating-guide.js";

export const MCODE_INSTRUCTIONS_MAX_CHARS = 4_000;

const EXPLICIT_MCODE_THREAD_TOKEN = /\b(?:mcode(?:[-_\s]+managed)?[-_\s]+threads?|mcode[-_\s]+thread[-_\s]?control|thread_(?:target_list|create_batch|search|get|send|stop|wait))\b/i;
const NEGATED_MCODE_THREAD_REQUEST = /\b(?:do\s+not|don['’]?t|dont|never|without|no)\b[\s\S]{0,96}\b(?:mcode(?:[-_\s]+managed)?[-_\s]+threads?|mcode[-_\s]+thread[-_\s]?control|thread_(?:target_list|create_batch|search|get|send|stop|wait))\b/i;
const MCODE_THREAD_REQUEST_ACTION = /\b(?:create|start|open|launch|use|manage|list|search|send|stop|wait|get|target|delegate)\b/i;

/** Capabilities proven available for one provider session. */
export interface McodeInstructionCapabilities {
  /** Internal thread-control MCP connection established for this session. */
  threadControl?: { sourceThreadId: string };
  /** Browser lease issued and registered for this session. */
  browserAutomation?: true;
}

/** Structured runtime guidance plan before provider-specific formatting. */
export interface McodeInstructionPlan {
  capabilities: McodeInstructionCapabilities;
  text: string;
}

/** Inputs used to derive capabilities after provider setup succeeds. */
export interface BuildMcodeInstructionPlanInput {
  sourceThreadId?: string;
  threadControlGranted: boolean;
  browserAutomationGranted: boolean;
  /** Optional provider-native model to use when a child must spawn another child. */
  nestedDelegationModel?: string;
}

/**
 * Returns true only when the user's current request explicitly names Mcode
 * thread control or one of its thread operations.
 *
 * Provider-native child-agent language intentionally does not satisfy this
 * boundary. Negated requests fail closed so a model cannot inherit a lease
 * from wording such as "do not create an Mcode thread".
 */
export function isExplicitMcodeThreadRequest(content: string): boolean {
  const request = content.trim();
  if (!request || NEGATED_MCODE_THREAD_REQUEST.test(request)) return false;
  if (!EXPLICIT_MCODE_THREAD_TOKEN.test(request)) return false;
  return MCODE_THREAD_REQUEST_ACTION.test(request);
}

const IDENTITY_BLOCK = [
  "You are operating inside an Mcode-managed session.",
  "Mcode runtime guidance is advisory; MCP authorization and lease state remain authoritative.",
].join(" ");

const THREAD_CONTROL_BLOCK = [
  "Use the mcode_internal_thread_control MCP server to manage Mcode threads only when explicitly asked by the user.",
  "An Mcode thread is a persistent user-visible conversation controlled by thread_* tools.",
  "For an explicit Mcode thread request, use workspace_search, worktree_list, thread_target_list, thread_create_batch, thread_search, thread_get, thread_send, thread_stop, and thread_wait as needed. Call thread_target_list before choosing a provider or model, pass exact returned IDs to thread_create_batch, and never assume or enumerate providers or models.",
  "Never target the source thread.",
].join(" ");

const PROVIDER_SUBAGENT_BLOCK = [
  "A child-agent or sub-agent request uses provider-native collaboration in the current turn.",
  "Use collaboration tools, preserve the exact requested brief, and keep direct and nested parent relationships intact.",
  "A child-agent request does not authorize Mcode thread control; use thread tools only for an explicit Mcode thread request.",
].join(" ");

const REPOSITORY_SEARCH_BLOCK = [
  "For broad repository searches, first list files with rg -l.",
  "Exclude fixtures and captured traces (*.ndjson) unless the task targets them, and bound line output with rg --max-columns 240 before reading matches.",
].join(" ");

function nestedDelegationBlock(model: string | undefined): string | undefined {
  const candidate = model?.trim();
  if (!candidate) return undefined;
  return [
    "When an explicitly requested provider-native child must spawn its own provider-native child, pass the nested-capable model",
    `"${candidate}"`,
    "in the parent spawn_agent call. Do not replace provider-native collaboration with shell commands or Mcode thread tools.",
  ].join(" ");
}

const BROWSER_BLOCK = MCODE_BROWSER_GUIDE.trim();

function capInstructionText(text: string): string {
  if (text.length <= MCODE_INSTRUCTIONS_MAX_CHARS) return text;
  const marker = "\n[ Mcode runtime guidance truncated at 4000 characters. ]";
  return text.slice(0, MCODE_INSTRUCTIONS_MAX_CHARS - marker.length) + marker;
}

function appendBlockIfItFits(blocks: string[], block: string): void {
  if ([...blocks, block].join("\n\n").length <= MCODE_INSTRUCTIONS_MAX_CHARS) blocks.push(block);
}

const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Builds canonical runtime guidance from capabilities proven at session setup. */
export function buildMcodeInstructionPlan(
  input: BuildMcodeInstructionPlanInput,
): McodeInstructionPlan {
  const candidateThreadId = input.sourceThreadId?.trim();
  const sourceThreadId = candidateThreadId && SAFE_THREAD_ID.test(candidateThreadId)
    ? candidateThreadId
    : undefined;
  const capabilities: McodeInstructionCapabilities = {};
  if (input.threadControlGranted && sourceThreadId) {
    capabilities.threadControl = { sourceThreadId };
  }
  if (input.browserAutomationGranted) capabilities.browserAutomation = true;

  const blocks = [IDENTITY_BLOCK, PROVIDER_SUBAGENT_BLOCK];
  const nestedBlock = nestedDelegationBlock(input.nestedDelegationModel);
  if (nestedBlock) blocks.push(nestedBlock);
  if (capabilities.threadControl) {
    blocks.push(`${THREAD_CONTROL_BLOCK} Source thread: ${capabilities.threadControl.sourceThreadId}.`);
  }
  if (capabilities.browserAutomation) blocks.push(BROWSER_BLOCK);
  appendBlockIfItFits(blocks, REPOSITORY_SEARCH_BLOCK);
  return { capabilities, text: capInstructionText(blocks.join("\n\n")) };
}

/** Formats canonical guidance for a provider-native instruction field. */
export function renderMcodeInstructions(plan: McodeInstructionPlan): string {
  return plan.text;
}
