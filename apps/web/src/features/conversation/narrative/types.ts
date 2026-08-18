import type { ToolCall, HookExecution } from "@/transport/types";
import type { SubagentLifecycle } from "./subagent-lifecycle";

/** One sibling Agent call rendered inside a compact parent collaboration row. */
export interface SubagentActivity {
  /** Lifecycle state of the delegated Agent call. */
  lifecycle: SubagentLifecycle;
  /** Agent call represented by this activity. */
  toolCall: ToolCall;
  /** Identity-bearing lineage participants for this activity. */
  participants: readonly ToolCall[];
  /** Direct child calls retained for the detail projection contract. */
  children: readonly ToolCall[];
  /** Agent hook activity retained for the detail projection contract. */
  hooks: readonly HookExecution[];
}

/**
 * Contiguous streamed reasoning text for one timeline row, bounded by tool use or turn end.
 */
export interface ThoughtSegment {
  /** Accumulated textDelta content for this segment. */
  text: string;
  /** Epoch ms when the first textDelta for this segment arrived. */
  startedAt: number;
  /** Epoch ms when the segment ended (next toolUse or turnComplete). Undefined if still streaming. */
  endedAt?: number;
  /** True when the provider explicitly classified this segment as non-final narration. */
  isExplicitNonFinal?: boolean;
}

/**
 * Coalesced consecutive tool calls rendered as one expandable summary row.
 */
export interface ToolGroup {
  /** Ordered calls in this group. */
  calls: readonly ToolCall[];
}

/**
 * One row in the live narrative timeline: thought, tool group, hook, subagent, active tool, or final delta.
 */
export type NarrativeItem =
  | { type: "thought"; segment: ThoughtSegment; isActive: boolean }
  | { type: "tool-group"; group: ToolGroup; hasError: boolean; hasCancelled: boolean }
  | { type: "hook"; hook: HookExecution }
  | {
      type: "subagent";
      lifecycle: SubagentLifecycle;
      toolCall: ToolCall;
      participants: readonly ToolCall[];
      children: readonly ToolCall[];
      hooks: readonly HookExecution[];
      /** Contiguous sibling Agent calls sharing the same parent timeline unit. */
      activities?: readonly SubagentActivity[];
    }
  | { type: "active-tool"; toolCall: ToolCall }
  | { type: "delta"; text: string };

/**
 * Aggregate counts for the timeline, derived during `buildNarrativeItems`.
 * Powers the per-turn footer that appears between the timeline and the final
 * assistant message when the agent is no longer running.
 */
export interface NarrativeCounts {
  /**
   * Total number of top-level timeline rows (one per top-level tool call).
   * Includes Agent calls — those are also surfaced separately as `subagents`.
   * Read alongside `subagents` as: "N steps, of which K were sub-agents".
   */
  steps: number;
  /**
   * Number of thought segments rendered as inline timeline rows.
   * The final streaming response is rendered as `delta`, not `thought`,
   * so it is intentionally excluded here.
   */
  thoughts: number;
  /**
   * Number of top-level Agent tool calls (delegated sub-agents).
   * Subset of `steps`.
   */
  subagents: number;
}

/** Return value of `buildNarrativeItems` — items plus aggregate counts. */
export interface NarrativeBuildResult {
  items: NarrativeItem[];
  counts: NarrativeCounts;
}
