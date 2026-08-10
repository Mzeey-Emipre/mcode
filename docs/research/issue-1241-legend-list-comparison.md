# Issue 1241: Message timeline adapter comparison

## Current finding

Keep the TanStack Virtual message timeline. Stock `@legendapp/list` 3.3.3 does not beat the current timeline across Electron and standalone web.

The first trial used Legend List 3.3.4. That version introduced a `ScheduledWork` receiver bug that crashes during React cleanup. The corrected trial pins stock 3.3.3, which has no scheduler bug. Version 3.3.3 renders reliably, but it loses four of five Electron medians, exceeds the normal-view DOM budget, fails one existing dense-narrative marker check, and emits a React render-phase update error.

The targeted TanStack option remains the strongest candidate. It enables `useAnimationFrameWithResizeObserver` and improves all five Electron medians. Its shared Markdown and Shiki fixture still needs a separate diagnosis before production use.

## Scope

- Source baseline: `6768f1e3`
- Prototype branch: `prototype/legend-list-1241`
- Viewport: 1440 by 1000
- Samples: three per valid variant, after warm-up
- Fixtures: 100 messages, 1,000 messages, two resident threads, 200 streaming deltas, and a 90-row dense narrative
- Legend List configuration: stock 3.3.3 with recycling disabled
- Runtime surfaces: Electron and standalone Chrome

The development query selects the prototype adapter:

- No parameter: current TanStack adapter
- `?messageTimeline=tanstack-raf`: TanStack with animation-frame ResizeObserver measurement
- `?messageTimeline=legend`: Legend List candidate

## Electron results

Each value is the median of three warm samples in milliseconds.

| Fixture | Current TanStack | TanStack RAF | Legend List 3.3.3 | Legend change from current |
| --- | ---: | ---: | ---: | ---: |
| 100 messages | 1,670.8 | 1,159.4 | 2,242.3 | 34.2% slower |
| 1,000 messages | 1,906.1 | 1,438.2 | 2,161.0 | 13.4% slower |
| Resident thread switch | 2,130.4 | 1,760.4 | 2,175.2 | 2.1% slower |
| 200 streaming deltas | 1,747.8 | 1,266.0 | 1,579.4 | 9.6% faster |
| 90-row dense narrative | 2,016.1 | 1,471.8 | 2,155.0 | 6.9% slower |

Legend List mounted 24 messages and 591 to 615 descendants for the 100-message fixture. This exceeds the 500-descendant budget in all three Electron samples. The current and targeted TanStack variants stayed below the budget.

## Standalone web results

Each value is the median of three warm samples in milliseconds.

| Fixture | Current TanStack | TanStack RAF | Legend List 3.3.3 | Legend change from current |
| --- | ---: | ---: | ---: | ---: |
| 100 messages | 1,093.0 | 930.9 | 1,038.3 | 5.0% faster |
| 1,000 messages | 967.3 | 874.7 | 867.7 | 10.3% faster |
| Resident thread switch | 1,032.2 | 1,029.5 | 799.1 | 22.6% faster |
| 200 streaming deltas | 867.8 | 790.5 | 630.8 | 27.3% faster |
| 90-row dense narrative | 1,029.3 | 924.3 | 831.1 | 19.3% faster |

Legend List improves the standalone web medians. It mounts 27 to 28 messages and 689 to 690 descendants for the 100-message fixture. This exceeds the 500-descendant budget in all three web samples.

## Correctness results

Version 3.3.3 passed four repeated Electron mount and cleanup checks. Each run mounted 24 messages, preserved the visible thread identity, and produced no console or page error.

The full matrices preserved thread identity, streaming text length, narrative text, and tool text. Two problems remain:

- Legend List did not preserve the dense narrative message marker used by the approved check.
- React reported a render-phase update from `ContainersInner` to `LegendListInner` in both runtimes.

The candidate already fails the cross-runtime performance, DOM, and correctness gates. The trial did not continue to the detailed prepend-anchor, hydration, accessibility, and sticky-preview checks.

## Bundle result

The web production build passed. The largest eager renderer chunk is 188,590 bytes gzip. The recorded current baseline is 156,222 bytes gzip. Legend List adds about 32.4 KB gzip and stays below the 512,000-byte chunk budget.

## Version boundary

Legend List 3.3.4 adds `ScheduledWork`. It stores `cancelAnimationFrame` as a tuple member and later calls that member with the tuple as its receiver. Chromium rejects the call with `TypeError: Illegal invocation`.

Legend List 3.3.3 has no `ScheduledWork`. It calls `cancelAnimationFrame` and `clearTimeout` directly. See [`issue-1241-legend-list-version-t3code.md`](./issue-1241-legend-list-version-t3code.md) for source links and the exact upstream diff.

## Why T3 Code uses Legend List

Current T3 Code pins a patched Legend List 3.3.3 for web and mobile. It removed TanStack Virtual to delegate tail following, row measurement, visible-position preservation, anchored composer space, and mobile keyboard behavior to one cross-platform list engine.

T3 Code carries a large package patch for inset, keyboard, end-anchor, first-paint, and row-transition behavior. Its choice is evidence of a product-specific fit, not evidence that stock Legend List is faster or more reliable for Mcode.

## Why Mcode uses TanStack Virtual

Mcode added `@tanstack/react-virtual` 3.13.23 in March 2026 to replace an O(n) message render with O(visible) DOM work. The integration uses dynamic row measurement and app-owned scroll compensation. Mcode later added thread restoration, prepend anchoring, wheel-intent history loading, streaming follow policy, and sticky-preview coordination around that engine.

Mcode does not have T3 Code's React Native keyboard requirement. The current comparison must therefore favor measured Electron and web behavior over cross-platform API coverage.

## Verification

- Focused timeline tests: 24 passed.
- Web production build: passed.
- Full gate: typecheck passed and lint passed. The unit-test phase exceeded its 10-minute limit without a recorded assertion failure.
- Evidence: `.dev/verification/issue-1241/electron-legend-3.3.3.json` and `.dev/verification/issue-1241/web-legend-3.3.3.json`.

## Recommendation

Reject stock Legend List 3.3.3 for this adoption decision. Keep TanStack Virtual. Diagnose the shared Markdown and Shiki fixture, then repeat the targeted TanStack RAF trial before production use.

Do not use the Legend List 3.3.4 crash as the rejection reason. Version 3.3.3 fixes that comparison flaw, but the corrected cross-runtime evidence still rejects the candidate.
