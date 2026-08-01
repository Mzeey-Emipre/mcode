/** Capability-derived runtime guidance shared by every provider adapter. */

export const MCODE_INSTRUCTIONS_MAX_CHARS = 4_000;

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
}

const IDENTITY_BLOCK = [
  "You are operating inside an Mcode-managed session.",
  "Mcode runtime guidance is advisory; MCP authorization and lease state remain authoritative.",
].join(" ");

const THREAD_CONTROL_BLOCK = [
  "Use the mcode_internal_thread_control MCP server for cross-thread orchestration.",
  "An Mcode task/thread/delegated thread is a persistent user-visible conversation controlled by thread_* tools. A subagent is provider/model-side delegation in the same turn.",
  "User wording 'use threads/tasks' maps to thread_* tools. User wording 'use subagents' maps to the provider subagent mechanism. Never translate one term into the other.",
  "Use workspace_search, worktree_list, thread_target_list, thread_create_batch, thread_search, thread_get, thread_send, thread_stop, and thread_wait as needed.",
  "When a delegated thread needs a named provider or model, call thread_target_list first, then pass the exact returned providerId and modelId to thread_create_batch. Do not assume or enumerate providers or models.",
  "Route delegated Mcode threads through Mcode thread tools. Never target the source thread.",
].join(" ");

const BROWSER_BLOCK = [
  "Use the mcode-browser MCP server for visible Browser automation.",
  "Use browser_status before actions, then browser_open, browser_navigate, browser_snapshot, browser_click, browser_type, browser_press, browser_scroll, and other granted browser tools.",
  "Operate only within the issued Browser lease and granted operations.",
].join(" ");

function capInstructionText(text: string): string {
  if (text.length <= MCODE_INSTRUCTIONS_MAX_CHARS) return text;
  const marker = "\n[ Mcode runtime guidance truncated at 4000 characters. ]";
  return text.slice(0, MCODE_INSTRUCTIONS_MAX_CHARS - marker.length) + marker;
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

  const blocks = [IDENTITY_BLOCK];
  if (capabilities.threadControl) {
    blocks.push(`${THREAD_CONTROL_BLOCK} Source thread: ${capabilities.threadControl.sourceThreadId}.`);
  }
  if (capabilities.browserAutomation) blocks.push(BROWSER_BLOCK);
  return { capabilities, text: capInstructionText(blocks.join("\n\n")) };
}

/** Formats canonical guidance for a provider-native instruction field. */
export function renderMcodeInstructions(plan: McodeInstructionPlan): string {
  return plan.text;
}
