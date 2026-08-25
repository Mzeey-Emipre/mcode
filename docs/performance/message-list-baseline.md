# Message List Performance Baseline

## Scope

This report records the final issue #1546 baseline from these raw artifacts only:

- `.dev/verification/performance/issue-1546-profiling-final.json`
- `.dev/verification/performance/issue-1546-production-final.json`

It records no candidate win and no dependency change. The pinned versions remain `@tanstack/react-virtual` 3.13.23 and `@tanstack/virtual-core` 3.13.23.

## Run contract

| Field | Value |
| --- | --- |
| Source revision | `250a153964347c7792b9a48ff39802c760540a48` |
| Source dirty | `true` in both artifacts and both runtimes |
| Viewport | 1440 x 1000 |
| Warmups | 1 |
| Raw samples | 7 per workload and runtime |
| Workload order | `message100`, `message1000`, `threadSwitch`, `streaming`, `messageListBehavior`, `denseNarrative`, `markdownShiki`, `panelTransitions` |

Overall, profiling accepted 107 samples and rejected 5. Production accepted 110 samples and rejected 2.

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Resolve-Path '.dev') 'playwright-browsers';
bun run perf:frontend -- --mode profiling --sample-count 7 --output .dev/verification/performance/issue-1546-profiling-final.json

$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Resolve-Path '.dev') 'playwright-browsers';
bun run perf:frontend -- --mode production --sample-count 7 --output .dev/verification/performance/issue-1546-production-final.json
```

## Environment and runtime signals

The artifacts record Windows `win32` release `10.0.26200`, an x64 12th Gen Intel(R) Core(TM) i7-12700 with 20 CPUs, and 68,373,008,384 bytes of host memory. They record Node 22.16.0, Electron 35.7.5, and Playwright 1.62.1.

| Runtime | Browser identity | Reported device memory | Fixed acceleration field |
| --- | --- | ---: | --- |
| standalone-web | HeadlessChrome 151.0.7922.34 | 32 GiB | `null` |
| electron | Chrome 134.0.6998.205 in Electron 35.7.5 | 8 GiB | `false` |

Profiling records no Chromium trace object for either runtime, so ResizeObserver, GC, layout, and paint trace values are unavailable there. The production Electron process signal is available and records `accelerationMode: "disabled"`; the standalone-web process signal is `null`. OS GPU counters are unavailable in both runtimes with the signal: `OS GPU counters are not available in the paired un-packaged runner`.

## Behavior baseline

All required MessageList checks passed except click-driven sticky jump to an initially unmounted row, which missed the 3.6s observation window in 5/14 profiling samples and 2/14 production samples; focused runs could pass, so this is load-sensitive current-baseline behavior, not a claimed migration result.

The cache contract exercised by this baseline is:

- A cache hit restores the saved reading anchor.
- Simulated cache eviction forgets scroll memory, holds the outgoing transcript during the cold load, then positions the restored transcript at the tail.

Each cell gives accepted/rejected raw samples. All seven samples ran for every workload and runtime.

| Workload | Profiling standalone-web | Profiling Electron | Production standalone-web | Production Electron |
| --- | ---: | ---: | ---: | ---: |
| message100 | 7/0 | 7/0 | 7/0 | 7/0 |
| message1000 | 7/0 | 7/0 | 7/0 | 7/0 |
| threadSwitch | 7/0 | 7/0 | 7/0 | 7/0 |
| streaming | 7/0 | 7/0 | 7/0 | 7/0 |
| messageListBehavior | 3/4 | 6/1 | 6/1 | 6/1 |
| denseNarrative | 7/0 | 7/0 | 7/0 | 7/0 |
| markdownShiki | 7/0 | 7/0 | 7/0 | 7/0 |
| panelTransitions | 7/0 | 7/0 | 7/0 | 7/0 |

## Workload durations

All values are milliseconds. The artifact summaries include accepted samples only, so the `messageListBehavior` summaries have three or six samples as shown by their accepted counts.

### Profiling, standalone-web

| Workload | Accepted/rejected | Min | Median | Max |
| --- | ---: | ---: | ---: | ---: |
| message100 | 7/0 | 120.3 | 127.6 | 181.2 |
| message1000 | 7/0 | 173.7 | 195.8 | 212.0 |
| threadSwitch | 7/0 | 96.3 | 112.7 | 137.6 |
| streaming | 7/0 | 16721.2 | 16737.8 | 16781.8 |
| messageListBehavior | 3/4 | 2664.8 | 2734.0 | 2739.7 |
| denseNarrative | 7/0 | 24.8 | 29.4 | 31.7 |
| markdownShiki | 7/0 | 3997.9 | 4063.1 | 4651.0 |
| panelTransitions | 7/0 | 56.0 | 58.3 | 65.8 |

### Profiling, Electron

| Workload | Accepted/rejected | Min | Median | Max |
| --- | ---: | ---: | ---: | ---: |
| message100 | 7/0 | 196.3 | 211.0 | 242.7 |
| message1000 | 7/0 | 208.9 | 213.5 | 223.1 |
| threadSwitch | 7/0 | 152.9 | 155.5 | 204.7 |
| streaming | 7/0 | 13435.2 | 13487.7 | 13948.9 |
| messageListBehavior | 6/1 | 3108.9 | 3365.7 | 3519.8 |
| denseNarrative | 7/0 | 34.8 | 40.7 | 44.6 |
| markdownShiki | 7/0 | 5687.2 | 5825.8 | 6204.3 |
| panelTransitions | 7/0 | 102.9 | 111.0 | 120.6 |

### Production, standalone-web

| Workload | Accepted/rejected | Min | Median | Max |
| --- | ---: | ---: | ---: | ---: |
| message100 | 7/0 | 75.6 | 109.5 | 124.9 |
| message1000 | 7/0 | 148.5 | 152.5 | 166.7 |
| threadSwitch | 7/0 | 106.8 | 111.7 | 148.5 |
| streaming | 7/0 | 16749.4 | 16774.7 | 16816.2 |
| messageListBehavior | 6/1 | 3181.4 | 3279.8 | 3319.7 |
| denseNarrative | 7/0 | 63.3 | 64.2 | 81.9 |
| markdownShiki | 7/0 | 5666.4 | 6134.6 | 7008.2 |
| panelTransitions | 7/0 | 84.5 | 94.1 | 95.9 |

### Production, Electron

| Workload | Accepted/rejected | Min | Median | Max |
| --- | ---: | ---: | ---: | ---: |
| message100 | 7/0 | 185.8 | 214.3 | 274.1 |
| message1000 | 7/0 | 159.0 | 185.3 | 217.4 |
| threadSwitch | 7/0 | 139.6 | 154.1 | 176.1 |
| streaming | 7/0 | 13438.8 | 13488.0 | 13901.5 |
| messageListBehavior | 6/1 | 2558.2 | 2574.0 | 2639.4 |
| denseNarrative | 7/0 | 42.3 | 45.5 | 51.4 |
| markdownShiki | 7/0 | 3940.5 | 4419.6 | 4665.5 |
| panelTransitions | 7/0 | 55.2 | 79.8 | 86.4 |

## MessageList attribution

This table records the narrow MessageList stages for `messageListBehavior` in profiling mode. Stage counts include every measured stage observation, not only the accepted workload samples.

| Runtime | Narrative stage count | Narrative median | Narrative p95 | TanStack stage count | TanStack median | TanStack p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| standalone-web | 39 | 0.2 | 0.6 | 384 | 0.0 | 0.1 |
| electron | 78 | 0.5 | 2.5 | 782 | 0.0 | 0.1 |

The React profiler is present for all 14 profiling `messageListBehavior` samples. It records 14 commits per runtime, and its actual and base duration minimum, median, and maximum are all 0.0 ms. React attribution is `null` for the corresponding production samples.

Production Chromium trace attribution is present for `messageListBehavior`. The table gives min, median, and max across its seven raw samples. ResizeObserver callback trace duration is `null` in both runtimes.

| Runtime | GC min/median/max | Layout min/median/max | Paint min/median/max |
| --- | ---: | ---: | ---: |
| standalone-web | 423.730 / 533.545 / 574.810 | 74.686 / 96.521 / 98.244 | 99.005 / 116.156 / 121.028 |
| electron | 879.900 / 923.831 / 997.533 | 97.836 / 112.967 / 118.839 | 106.737 / 114.805 / 118.057 |

## Shiki attribution

`codeToHtml` is the largest Shiki stage in every runtime and mode. Values below are medians in milliseconds. A dash means the artifact reports `null` for that stage.

### Profiling Shiki medians

| Runtime | Phase | Worker startup | Highlighter creation | Grammar load | Code to HTML | Worker delivery | React commit | HTML insertion | Total completion |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| standalone-web | cold, n=7 | 0.5 | 1.1 | 3.0 | 494.1 | 7.0 | 1.3 | 0.0 | 574.9 |
| standalone-web | warm, n=63 | - | 0.0 | 0.0 | 372.3 | 8.0 | 0.8 | 0.0 | 2507.7 |
| electron | cold, n=7 | 3.9 | 1.6 | 4.9 | 559.4 | 3.0 | 1.5 | 0.0 | 726.9 |
| electron | warm, n=63 | - | 0.0 | 0.0 | 553.2 | 4.0 | 1.6 | 0.0 | 3534.7 |

Profiling Shiki style and layout fields are `null`.

### Production Shiki medians

| Runtime | Phase | Worker startup | Highlighter creation | Grammar load | Code to HTML | Worker delivery |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| standalone-web | cold, n=7 | 5.0 | 1.7 | 4.8 | 616.1 | 7.0 |
| standalone-web | warm, n=63 | - | 0.0 | 0.0 | 562.2 | 10.0 |
| electron | cold, n=7 | 4.7 | 1.0 | 3.0 | 503.9 | 4.0 |
| electron | warm, n=63 | - | 0.0 | 0.0 | 386.6 | 4.0 |

Production `reactCommit`, `htmlInsertion`, and `totalCompletion` fields are `null`. Production workload style and layout fields are available:

| Runtime | Style min/median/max | Layout min/median/max |
| --- | ---: | ---: |
| standalone-web | 97.951 / 109.194 / 127.527 | 46.340 / 50.839 / 57.788 |
| electron | 101.389 / 113.301 / 127.111 | 45.503 / 48.114 / 54.967 |

The response-byte fields are present. Cold samples have n=7 and warm samples have n=63 in every runtime and mode. Their median bytes are 32,485 and 32,485 for profiling standalone-web, 32,345 and 32,293 for profiling Electron, 32,310 and 32,345 for production standalone-web, and 32,485 and 32,485 for production Electron.

## Limits

- This is a baseline from a dirty source tree, not a before-and-after comparison.
- Rejected behavior samples remain in the raw artifacts but not in duration summaries.
- The standalone-web acceleration field is `null`; it does not establish an acceleration setting.
- The profiling artifacts contain no Chromium trace attribution.
- GPU counters are unavailable in the paired un-packaged runner.
- The artifacts do not provide Electron process measurements except the production Electron signal.
