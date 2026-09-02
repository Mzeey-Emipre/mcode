---
status: accepted
---

# Backend runs with a 512 MB heap cap, bounded tool output, and graduated pressure shedding

## Context

The packaged backend crashed with `FATAL ERROR: Reached heap limit` while
running under the 96 MB default heap (#709). The spike behind that issue found
two compounding causes:

1. **The heap default contradicts the documented policy.** The settings schema
   and the desktop spawn path default to 96 MB while the architecture docs say
   512 MB. The 96 MB value was chosen to protect the < 150 MB idle-memory
   target, but that reasoning is wrong: `--max-old-space-size` is a cap, not an
   allocation. Raising the cap costs zero idle RSS.
2. **Active-turn retention is unbounded.** The Codex provider buffers streamed
   command output and sub-agent text as ever-growing strings, then emits the
   full text in the `ToolResult` event, persists it, and mirrors it in the
   frontend. A synthetic repro OOM'd a 96 MB heap with a single 40 MB tool
   output; JSON serialization roughly doubles peak usage. Buffers are cleared
   between turns, so this is within-turn growth, not a classic leak.

Memory pressure handling today is idle-only: nothing observes the heap while a
turn is running, which is exactly when growth happens. After a crash there is
no automatic restart, and the stderr log is truncated on the next spawn, which
destroys the crash evidence.

The fix spans several issues (#710 epic, slices #711 to #717) that will be
implemented by independent agents. The policy constants and contract shapes
below are pinned here so the slices stay consistent. Slice-level behavior
lives in the issues, not here.

## Decision

### Heap policy (#712)

- Default server heap cap: **512 MB**. Floor: **256 MB**. Ceiling stays at
  8192 MB. Values below the floor are invalid; 96 MB is no longer a supported
  low-memory mode.
- A persisted `heapMb` of exactly **96** (the old default) is treated as unset
  during settings load, so existing installs migrate to 512 without losing any
  other explicit choice.
- Resolution order: `MCODE_SERVER_HEAP_MB` env var, then `settings.json`, then
  the default. An invalid env value falls through to the next source, not
  straight to the default.

### Bounded tool output (#711)

- Per tool call and per sub-agent, retained output is capped at a budget of
  **256 KB**: the first **192 KB** plus the last **64 KB** when truncating.
- Truncated `ToolResult` events carry the bounded preview plus three fields,
  pinned so server, contracts, and frontend agree:
  `outputTruncated: boolean`, `outputTotalBytes: number`, and
  `outputArtifactPath: string | undefined`.
- Full output is spooled to
  `$MCODE_DATA_DIR/artifacts/tool-output/<threadId>/<toolCallId>.txt` and
  cleaned up on the same 14-day cadence as log files.
- Streaming buffers accumulate chunks in arrays and join once at completion;
  no repeated string concatenation per delta.

### Pressure ladder (#716, #717)

Thresholds are fractions of the configured heap limit, never absolute bytes:

- **Warning at 80%:** providers switch to truncate-mode buffering and idle
  pooled provider sessions are evicted.
- **Critical at 90%:** new turns are rejected with a user-visible error; the
  pool shrinks to sessions with an active turn.
- An in-flight turn is never killed by shedding. Only new work is refused.

### Crash handling (#713)

- One rotated generation of the stderr log (`server-stderr.1.log`) survives
  each spawn.
- Packaged builds spawn with `--report-on-fatalerror`, writing reports into
  the data directory.
- Abnormal exit triggers restart with backoff (1 s, 5 s, 15 s). Three crashes
  within five minutes stop the retries and surface an error state.

### History reads (#714)

Fork and handoff read history in pages, newest first, under a **4 MB** byte
budget per operation, and report when older history was elided.

## Considered Options

- **Keep 96 MB and enforce a strict low budget (rejected).** A single large
  tool output already exceeds it, and the idle target the 96 MB value was
  protecting is unaffected by the cap. The budget work (bounding, shedding) is
  still worth doing, but on top of a survivable cap.
- **Raise the cap without bounding output (rejected).** Any fixed cap loses to
  unbounded retention; the user's 2 GB override only moves the cliff. Bounding
  at the event mapper fixes every downstream copy (serialization, DB, frontend)
  in one place.
- **Unlimited heap (rejected).** Hides retention bugs until the OS is under
  pressure, and turns a contained backend crash into whole-machine pain.
- **Always spool output to disk, no in-memory path (rejected).** Pays file IO
  on every small output to simplify the rare large one. The 256 KB threshold
  keeps the common case allocation-only.

## Consequences

- The `ToolResult` contract gains truncation metadata; the schema change lives
  in `packages/contracts` and every consumer must typecheck.
- ARCHITECTURE.md and the settings reference must match the new defaults; the
  512 MB figure in the docs becomes true instead of aspirational.
- Users who explicitly chose 96 MB get silently migrated to 512. Accepted:
  96 was the shipped default, so an explicit choice of it is indistinguishable
  from inertia, and it is below the new supported floor anyway.
- The budget constants (256 KB, 80%, 90%, 4 MB) are policy, not settings. If a
  real need to tune them emerges they can graduate to settings later under the
  existing schema conventions; that would be a new decision, not a reversal.
- Full tool output is no longer in the database row, so anything that re-reads
  persisted turns (handoff, fork, timeline reload) sees the bounded preview
  unless it explicitly reads the artifact file.
