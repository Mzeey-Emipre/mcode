# Issue 1241: Message timeline adapter comparison

## Decision

Keep the TanStack Virtual message timeline. Reject `@legendapp/list` 3.3.4 for this trial.

The Legend List candidate fails during React cleanup in both web and Electron. The failure leaves the timeline empty and activates `AppErrorBoundary`. Its short render times are invalid because it mounts no messages.

Test a separate TanStack change that enables `useAnimationFrameWithResizeObserver`. It passed the bounded timeline correctness checks and reduced the Electron median times by 17.4% to 30.6% in this trial. Do not ship that change from this prototype branch. The full web fixture still has an intermittent Markdown and Shiki readiness failure that affects both TanStack variants.

## Scope

- Source baseline: `6768f1e3`
- Prototype branch: `prototype/legend-list-1241`
- Viewport: 1440 by 1000
- Samples: three per valid variant, after warm-up
- Fixtures: 100 messages, 1,000 messages, two resident threads, 200 streaming deltas, and a 90-row dense narrative
- Legend List configuration: recycling disabled
- Runtime surfaces: web and Electron

The query parameter selects the prototype adapter in development:

- No parameter: current TanStack adapter
- `?messageTimeline=tanstack-raf`: TanStack with animation-frame ResizeObserver measurement
- `?messageTimeline=legend`: Legend List candidate

## Electron results

The baseline and targeted variant ran in the same clean Electron session. Each value is the median of three samples.

| Fixture | Current TanStack | TanStack RAF | Change |
| --- | ---: | ---: | ---: |
| 100 messages | 1,670.8 ms | 1,159.4 ms | -30.6% |
| 1,000 messages | 1,906.1 ms | 1,438.2 ms | -24.5% |
| Resident thread switch | 2,130.4 ms | 1,760.4 ms | -17.4% |
| 200 streaming deltas | 1,747.8 ms | 1,266.0 ms | -27.6% |
| 90-row dense narrative | 2,016.1 ms | 1,471.8 ms | -27.0% |

Both TanStack variants preserved the expected thread identity, streaming text length, narrative content, and bounded mounted row count.

The one-sample Electron Legend List check mounted zero messages for both list sizes. It also returned no visible thread or narrative content. The console reported `TypeError: Illegal invocation` from `ScheduledWork.cancel` in `@legendapp/list`.

## Web results

The targeted TanStack variant reduced the median for four of the five timeline fixtures by 8.9% to 14.8%. The resident thread switch was unchanged within the trial noise. Both variants preserved timeline correctness.

The full web matrix found an intermittent Markdown and Shiki readiness failure in one of three samples for both TanStack variants. This shared failure prevents a no-regression claim for the targeted change until it is isolated.

The Legend List web run failed with the same `ScheduledWork.cancel` exception as Electron. The package stores browser cancellation functions and calls them without their browser receiver during cleanup. Chromium rejects that call as an illegal invocation.

## Bundle result

The desktop build passed. The largest eager renderer chunk increased from the recorded 156,222 bytes gzip baseline to 189,150 bytes gzip. The candidate adds about 32.9 KB gzip and stays below the 512,000-byte chunk budget. The runtime failure rejects the candidate before bundle size becomes the deciding factor.

## Live provider check

Electron used the Codex provider with GPT-5.6 Luna, High reasoning, and Full access. The test sent a real turn in `fixture-repo`. Luna returned the required text, and the composer returned to its idle state.

## Follow-up

Create a production issue for the TanStack animation-frame option only after the shared Markdown and Shiki fixture failure is understood. Keep the Legend List dependency and adapter confined to this throwaway prototype branch.
