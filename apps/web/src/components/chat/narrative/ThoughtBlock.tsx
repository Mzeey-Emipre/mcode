import type { ThoughtSegment } from "./types";
import { DeltaBlock } from "./DeltaBlock";

/** Props for {@link ThoughtBlock}. */
interface ThoughtBlockProps {
  segment: ThoughtSegment;
  isActive: boolean;
}

/**
 * Renders a single text content block (formerly the "thought" row) as plain
 * body prose in the timeline.
 *
 * Despite the historical name, this component no longer dims or italicises
 * its content. The renderer was originally responsible for "preamble" text —
 * text streamed before a tool call with `stop_reason: tool_use`. The
 * Anthropic Messages API tags both pre-tool and post-tool text as `text`-typed
 * content blocks, and only `thinking`-typed blocks represent genuine internal
 * reasoning the user should not have to read. Rendering preamble text as a
 * dimmed aside hid the actual answer in flows like the goal stop-hook, where
 * the model answers fully before running a verification tool call.
 *
 * Delegates to `DeltaBlock` so live and persisted text rows share one
 * renderer — typewriter reveal and an end-of-text cursor while the segment
 * is still streaming, static prose once it has settled.
 */
export function ThoughtBlock({ segment, isActive }: ThoughtBlockProps) {
  return (
    <div className="px-2 py-1 text-sm text-foreground">
      {/* `showCursor={false}` — a thought rendered in the timeline is either
          settled (turn over) or just-closed because a tool_use boundary
          fired. In neither case is the agent actively typing INTO this block:
          the next deltas land in a different segment (or in the streaming
          response slot below). Suppressing the caret here prevents stacking
          multiple blinking cursors across the timeline as preamble segments
          accumulate. The typewriter reveal still plays via `isStreaming`. */}
      <DeltaBlock text={segment.text} isStreaming={isActive} showCursor={false} />
    </div>
  );
}
