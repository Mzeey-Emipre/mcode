import type { HookExecutionRecord, ThoughtSegmentRecord, ToolCallRecord } from "@/transport/types";
import {
  preparePersistedNarrative,
  projectPersistedNarrativeItems,
  type PersistedNarrativeInputs,
} from "./persisted-narrative-timeline";
import type { NarrativeItem } from "./types";

export type { PersistedNarrativeInputs } from "./persisted-narrative-timeline";
export {
  persistedHookDetailLines,
  recordToHookExecution,
  recordToToolCall,
} from "./persisted-narrative-timeline";

const memoCache = new WeakMap<
  readonly ThoughtSegmentRecord[],
  WeakMap<
    readonly ToolCallRecord[],
    WeakMap<readonly HookExecutionRecord[], Map<string, NarrativeItem[]>>
  >
>();

/** Reconstructs static timeline rows from persisted narrative records. */
export function buildPersistedNarrativeItems(
  inputs: PersistedNarrativeInputs,
): NarrativeItem[] {
  if (inputs.tools.length === 0 && inputs.thoughts.length === 0 && inputs.hooks.length === 0) {
    return [];
  }

  const messageContent = (inputs.messageContent ?? "").trim();
  const cached = readMemoizedItems(inputs.thoughts, inputs.tools, inputs.hooks, messageContent);
  if (cached) return cached;

  const items = projectPersistedNarrativeItems(preparePersistedNarrative(inputs));
  writeMemoizedItems(inputs.thoughts, inputs.tools, inputs.hooks, messageContent, items);
  return items;
}

function readMemoizedItems(
  thoughts: readonly ThoughtSegmentRecord[],
  tools: readonly ToolCallRecord[],
  hooks: readonly HookExecutionRecord[],
  messageContent: string,
): NarrativeItem[] | undefined {
  return memoCache.get(thoughts)?.get(tools)?.get(hooks)?.get(messageContent);
}

function writeMemoizedItems(
  thoughts: readonly ThoughtSegmentRecord[],
  tools: readonly ToolCallRecord[],
  hooks: readonly HookExecutionRecord[],
  messageContent: string,
  items: NarrativeItem[],
): void {
  const toolsCache = memoCache.get(thoughts) ?? new WeakMap<
    readonly ToolCallRecord[],
    WeakMap<readonly HookExecutionRecord[], Map<string, NarrativeItem[]>>
  >();
  const hooksCache = toolsCache.get(tools) ?? new WeakMap<
    readonly HookExecutionRecord[],
    Map<string, NarrativeItem[]>
  >();
  const contentCache = hooksCache.get(hooks) ?? new Map<string, NarrativeItem[]>();
  contentCache.set(messageContent, items);
  hooksCache.set(hooks, contentCache);
  toolsCache.set(tools, hooksCache);
  memoCache.set(thoughts, toolsCache);
}
