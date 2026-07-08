# LegendList-style list performance candidates

## Goal

Apply LegendList-inspired architecture where Mcode renders long, dynamic, or
frequently changing lists. Focus on lower memory use, fewer React renders, stable
scroll position, and better behavior during streaming updates.

## Candidate areas

1. Chat narrative timeline
   - Highest value target.
   - Covers agent turns, tool calls, thoughts, hooks, sub-agent rows, handoff
     events, and streaming assistant responses.
   - Needs dynamic row measurement, anchored prepends, and granular updates for
     streaming text and tool-call status.

2. Thread and message history
   - Important when loading older messages or switching long-running threads.
   - Preserve the user's viewport when older history is prepended.
   - Avoid re-rendering stable messages when the current turn streams.

3. Runtime logs and provider output
   - Append-heavy and potentially unbounded.
   - Keep mounted rows and retained log buffers capped.
   - Batch high-frequency updates before they reach React.

4. Agent and task activity views
   - Useful for running agents, tool calls, steps, status changes, and queue
     state.
   - Each row should subscribe to its own status and metadata.

5. Large search and file result lists
   - Lower priority than chat and logs.
   - Virtualization is likely enough unless result rows become dynamic or
     frequently updated.

## Principles to test in implementation

- Render only visible rows plus a small overscan buffer.
- Keep row identity stable.
- Prefer row-level subscriptions over parent list state updates.
- Cache measured heights and update them deliberately.
- Preserve scroll anchors when content is prepended, resized, expanded, or
  streamed.
- Avoid cloning or replacing the full list for one-row changes.
- Bound mounted UI, measurement caches, event buffers, and log retention.

## First implementation slice

Audit the chat narrative timeline and identify which updates currently cause
the full timeline or sibling rows to re-render. Use that audit to choose the
smallest change that reduces renders without changing the user-facing behavior.
