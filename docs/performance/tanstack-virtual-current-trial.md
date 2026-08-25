# TanStack Virtual Current-Stable Trial

## Decision

Keep `@tanstack/react-virtual` 3.13.23 and `@tanstack/virtual-core` 3.13.23.
The 3.14.10 trial did not pass the MessageList behavior gate. The duration
samples therefore do not support an upgrade.

This report records a reversible dependency trial for issue #1547. The trial
changed only `bun.lock` while it ran. The original lock file and installed
packages were restored before this report was added.

## Candidate

The release state was frozen at approximately `2026-08-25T14:59Z`.

| Package | Candidate version | Published | Tarball integrity | Release commit |
| --- | --- | --- | --- | --- |
| `@tanstack/react-virtual` | 3.14.10 | 2026-08-18 15:06:28.045 UTC | `sha512-SRyoUbdFMRHuYXMijV5H4ZarQWpXkj3iANq8OFre+pybeVap8ZJjZ3Nz9bVjx4d8PfobVUQUdKyyyHYk3E+djw==` | `e9874f033c74afd3251eeb9f3e60b2530cc7ae88` |
| `@tanstack/virtual-core` | 3.17.8 | 2026-08-18 15:06:21.826 UTC | `sha512-BfEvehNpOT75r5Ksc5xW6NZuXujTfb7nlSEyVu4XHG3gdxNg1KqXruWbDewXOUaUYIo4oRbSfkjIajz4MAT8tA==` | `e9874f033c74afd3251eeb9f3e60b2530cc7ae88` |

The candidate lock entries used the official tarballs:

- `https://registry.npmjs.org/@tanstack/react-virtual/-/react-virtual-3.14.10.tgz`
- `https://registry.npmjs.org/@tanstack/virtual-core/-/virtual-core-3.17.8.tgz`

Official sources: [React change log](https://github.com/TanStack/virtual/blob/main/packages/react-virtual/CHANGELOG.md),
[core change log](https://github.com/TanStack/virtual/blob/main/packages/virtual-core/CHANGELOG.md),
and [release commit](https://github.com/TanStack/virtual/commit/e9874f033c74afd3251eeb9f3e60b2530cc7ae88).

The existing application range, `^3.13.23`, accepted 3.14.10. The candidate
lock resolved React Virtual 3.14.10 and its nested Virtual Core dependency
3.17.8. A frozen install and both candidate runner builds succeeded with no
product-source change or public API incompatibility. The candidate tree differed
from the clean baseline only in `bun.lock`.

## Run contract

All four runs used source revision `b04b632061f335e010c24de0b2edaf17e1360688`.
The runner used a 1440 by 1000 viewport, one warmup, and seven samples for each
workload and runtime. The workload order was `message100`, `message1000`,
`threadSwitch`, `streaming`, `messageListBehavior`, `denseNarrative`,
`markdownShiki`, and `panelTransitions`.

All four artifacts record Playwright 1.62.1. Standalone web reported no
acceleration field. Electron reported disabled acceleration in every artifact.
The baseline artifacts were clean at `b04b6320`. The candidate artifacts had
`sourceDirty: true` because the temporary dependency resolution changed only
`bun.lock`.

```powershell
bun run perf:frontend -- --mode profiling --sample-count 7 --output .dev/verification/performance/issue-1547-baseline-profiling.json
bun run perf:frontend -- --mode production --sample-count 7 --output .dev/verification/performance/issue-1547-baseline-production.json
bun run perf:frontend -- --mode profiling --sample-count 7 --output .dev/verification/performance/issue-1547-candidate-profiling.json
bun run perf:frontend -- --mode production --sample-count 7 --output .dev/verification/performance/issue-1547-candidate-production.json
```

Each command wrote its raw artifact but exited 1 when the runner rejected one
or more behavior samples. The exit status preserves the runner contract. It
does not discard accepted samples from the artifact.

## Behavior results

The fresh issue #1547 baseline records the known load-sensitive sticky jump. It
missed the 3.6-second observation window in six of 14 profiling samples and
two of 14 production samples. The accepted issue #1546 baseline recorded five
of 14 profiling misses and two of 14 production misses. This fresh rerun shows
load-sensitive variation. It does not replace or restate the accepted #1546
artifacts. The candidate run did not prove parity:

- Candidate profiling rejected all 56 Electron samples after a WebSocket
  closure and connection refusal. Treat its Electron React data as invalid.
- Candidate production observed two standalone-web sticky jumps and five
  Electron sticky jumps. The baseline production observed zero standalone-web
  and two Electron sticky jumps. The candidate run therefore observed five
  more sticky failures in total, including three more in Electron.
- Candidate production also observed two Electron streaming failures. Each
  failed sample did not commit all 200 visible updates, did not keep the tail in
  view, and moved a user who had left the tail. Baseline production accepted all
  14 streaming samples.

The message-list behavior samples that reached their assertions still recorded
dynamic Markdown heights, older and newer anchors, cache-hit restoration,
cache-miss tail restoration, live-to-persisted identity, focus, and interactive
controls, resident thread switch, and text selection. The sticky jump targets
were initially unmounted. The failed sticky samples did not reach the required
transcript row within the observation window.

| Mode | Runtime | Baseline accepted/rejected | Candidate accepted/rejected | Result |
| --- | --- | ---: | ---: | --- |
| Profiling | standalone web | 54/2 | 55/1 | Candidate sticky behavior remained load-sensitive. |
| Profiling | Electron | 52/4 | 0/56 | Candidate Electron run was invalid after socket failures. |
| Production | standalone web | 56/0 | 54/2 | Candidate run observed two sticky-jump rejections. |
| Production | Electron | 54/2 | 49/7 | Candidate run observed three more sticky and two streaming rejections. |
| Total | both runtimes | 216/8 | 158/66 | Candidate run did not prove parity. |

The reported candidate profiling Electron socket errors are a runner
observation, not evidence that TanStack Virtual caused a product failure. They
still prevent that run from proving parity or a performance result. The
production behavior observations alone fail the candidate under the predeclared
behavior-parity gate.

## Accepted-sample duration comparison

These values are medians in milliseconds from accepted standalone-web samples.
They are descriptive only. Candidate behavior failed, and sample pools differ,
so no row supports a performance claim.

### Profiling

| Workload | Baseline | Candidate |
| --- | ---: | ---: |
| `message100` | 81.5 | 128.1 |
| `message1000` | 81.5 | 149.3 |
| `threadSwitch` | 59.3 | 123.2 |
| `streaming` | 16738.1 | 16745.3 |
| `messageListBehavior` | 3159.3 | 3162.3 |
| `denseNarrative` | 35.2 | 32.0 |
| `markdownShiki` | 8237.7 | 6095.4 |
| `panelTransitions` | 76.0 | 72.0 |

### Production

| Workload | Baseline | Candidate |
| --- | ---: | ---: |
| `message100` | 123.9 | 124.4 |
| `message1000` | 137.1 | 150.7 |
| `threadSwitch` | 114.3 | 127.1 |
| `streaming` | 16729.4 | 16720.6 |
| `messageListBehavior` | 2927.6 | 2986.6 |
| `denseNarrative` | 37.6 | 42.3 |
| `markdownShiki` | 5744.1 | 4425.8 |
| `panelTransitions` | 55.7 | 67.8 |

## Attribution boundaries

React data came from profiling builds. In accepted standalone-web
`messageListBehavior` samples, React actual duration had a median of 0.0 ms in
both baseline and candidate data. The narrow MessageList stages also had the
same median: narrative-item projection was 0.4 ms and `getVirtualItems()` was
0.0 ms. Their p95 values were 0.7 ms and 0.1 ms. The sample counts differed,
so these values do not establish an improvement.

Chromium trace data came from production builds. Electron process CPU and
memory data came from production Electron samples. OS GPU counters were
unavailable in all four artifacts. The candidate did not pass behavior, and its
profiling Electron samples were invalid, so the Chromium and process signals
are recorded in the raw artifacts but are not compared as upgrade evidence.

## Upstream review

The candidate includes upstream work for scroll compensation above or across
the fold, dynamic `scrollToIndex`, DOM-node identity cleanup, end anchoring,
cached measurements, skipping redundant unchanged-offset scroll events,
allocation reduction, ResizeObserver and count-shrink safety, pending
observer-reset cancellation, and observer teardown state reset.

React Virtual 3.14.0 also adds opt-in `directDomUpdates`. Mcode does not set
that option. The candidate build succeeded with the existing Mcode options and
showed no public API break. This trial did not edit product code or opt in to
new APIs.

## Restoration and limits

The temporary lockfile was restored byte-for-byte. Its saved and restored
SHA-256 value was `54D9671BAB3EC886AF5BBCA8FFB205C9978C44CEC6F47993AECF4CF4CB708825`.
A frozen install then resolved React Virtual and Virtual Core back to 3.13.23.
No dependency manifest or lockfile change remains.

The candidate fails the behavior gate, so this trial cannot decide whether a
future version can improve Mcode. The profiling Electron socket failure also
limits attribution. A future trial needs a candidate that first passes the
full behavior matrix in both runtimes. Only then can matched accepted samples
support an upgrade decision.

## Raw artifacts

- `.dev/verification/performance/issue-1547-baseline-profiling.json`
- `.dev/verification/performance/issue-1547-baseline-production.json`
- `.dev/verification/performance/issue-1547-candidate-profiling.json`
- `.dev/verification/performance/issue-1547-candidate-production.json`
