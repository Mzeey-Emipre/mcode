# Issue 1242: Legend-State volatile narrative prototype

## Decision

Do not adopt Legend-State for the volatile narrative path. Keep Zustand as the authority and use targeted React row memoization if this optimization proceeds.

The bounded Legend-State seam was slower than both the current path and the targeted Zustand alternative. It also rendered more rows and retained more JavaScript heap during the fixture. The targeted Zustand path produced the best result without adding a beta dependency.

## Scope

The prototype changed only volatile narrative rendering for streaming text, tool progress, hook progress, thought segments, and keyed narrative rows. It did not move conversation residency, persisted messages, workspace state, or server authority.

The Legend variant used `@legendapp/state` 3.0.0-beta.48 with plain observables, `batch`, and React `useValue`. It did not use persistence, synchronization, `observer`, or automatic tracking.

## Fixture

Each sample used the same 1440 by 1000 viewport and fixture:

- 100 persisted messages
- 30 completed tools
- 4 parallel subagents with 5 child tools each
- 1 active tool
- 20 thought segments
- 10 hooks
- 200 tool progress events
- 50 hook progress events
- 200 non-final text delta events

Web measurements used seven recorded samples per variant. Electron measurements used three recorded samples per variant. Each run also included one unrecorded warmup sample.

## Results

| Runtime | Variant | Median | p95 | Median row renders | Observed heap change |
|---|---:|---:|---:|---:|---:|
| Web | Current | 755.7 ms | 999.0 ms | 236 | +34,924,658 bytes |
| Web | Targeted Zustand | 653.8 ms | 882.4 ms | 120 | +18,560,066 bytes |
| Web | Legend-State | 1,145.6 ms | 1,786.0 ms | 350 | +61,929,942 bytes |
| Electron | Current | 3,301.9 ms | 3,341.0 ms | 236 | +9,885,535 bytes |
| Electron | Targeted Zustand | 2,117.0 ms | 2,230.3 ms | 120 | +1,623,745 bytes |
| Electron | Legend-State | 4,371.8 ms | 4,658.3 ms | 350 | +43,231,013 bytes |

Against the current path, targeted Zustand reduced the median by 13.5 percent on web and 35.9 percent in Electron. Legend-State increased the median by 51.6 percent on web and 32.4 percent in Electron.

Heap values are observed end-to-start changes without forced garbage collection. They are a comparative signal, not a leak measurement.

## Correctness checks

All three web variants, plus the Legend Electron variant, passed the following checks with no page or console errors:

- active tool progress ended at 200 seconds
- the final thought retained the last non-final text delta
- the running hook retained its initial line plus 50 progress lines
- tools, thoughts, and hooks survived `turn.persisted`
- A-B-A thread switching restored the expected thread
- every visible narrative row had a unique stable key
- scroll bottom-distance drift was 16 pixels for every variant, so neither prototype regressed the current anchoring behavior

The three recorded Electron performance runs also had no page or console errors and preserved persisted volatile state, row-key uniqueness, and thread identity.

## Bundle evidence

The built renderer entry was 525,256 bytes raw and 148,990 bytes at gzip level 9. The exact Legend imports used by the prototype bundled to 35,059 bytes raw and 13,589 bytes gzipped with React externalized.

The full renderer entry remained below the repository's 2 MB gzip target. The isolated import measurement identifies the added dependency surface without claiming a misleading before-and-after delta across different source revisions.

## Recommendation

Reject Legend-State for this seam. If the parent map chooses to optimize volatile narrative rendering, carry forward the targeted memoized Zustand row approach and validate it as production code in a separate implementation ticket.
