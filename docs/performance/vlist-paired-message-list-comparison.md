# vlist paired MessageList comparison

## Decision state

Issue #1549 did not reach behavior eligibility. The development-only vlist
prototype remains unrun and inconclusive. Do not classify vlist as ineligible
from this run. No decision-grade timing ran.

The production `MessageList` remains on `@tanstack/react-virtual` 3.13.23.
No production MessageList file, dependency manifest, or lockfile changed.
The development-only candidate is `vlist` 2.6.1.

## Intended run contract

| Field | Value |
| --- | --- |
| Mode | Profiling |
| Runtimes | Standalone web and Electron |
| Viewport | 1440 x 1000 |
| Warmups | 1 |
| Requested samples | 3 per runtime |
| Workload | `vlistLifecycle` only |
| Runner completion bound | 480,000 ms, calculated as 120,000 plus three 120,000 ms sample budgets |

The development probe has semantic checks for the prior lifecycle and
fixed-height prepend work plus dynamic height, tail follow, user-away posture,
sticky jump, text selection, direct message scrolling, thread anchor restore,
and off-screen retained state. The maintained validator test changes one fact
for each behavior check and requires the lifecycle gate to reject it. This
confirms the gate conditions, not runtime eligibility.

## Run evidence

The paired command started at `2026-08-26T16:15:09+01:00`:

```powershell
bun run perf:frontend -- --mode profiling --sample-count 3 --workload vlistLifecycle --output .dev/verification/performance/issue-1549-vlist-eligibility-profiling.json
```

The renderer build completed at `2026-08-26T16:17:06+01:00`. The worker
started Electron at `2026-08-26T16:17:08+01:00`. The runner exited with code 1
at approximately `2026-08-26T16:25:14+01:00` after its own 480,000 ms bound:

```text
Frontend performance worker exceeded 480000 ms
```

At the deadline, the run had no result JSON, no `.complete` receipt, and no
worker failure receipt. The supporting build and timeout logs remain under
`.dev/verification/performance/` as
`issue-1549-vlist-eligibility-profiling-attempt2.stdout.log` and
`issue-1549-vlist-eligibility-profiling-attempt2.stderr.log`. They contain no
behavior facts or duration samples.

The narrow standalone diagnostic below ran at `2026-08-26T16:30+01:00` and
exited 1 in 6.6 seconds. Chromium was spawned, but Playwright did not attach
within the explicit five-second limit:

```powershell
bun --eval '<Playwright chromium.launch({ headless: true, timeout: 5_000 }) probe>'
```

The same probe invoked through the paired runner's Electron executable with
`ELECTRON_RUN_AS_NODE=1` exited 0 in 6.1 seconds but emitted no probe line or
receipt. It is not trustworthy evidence that the probe ran. This observation
does not confirm an external environment failure, and it does not identify a
vlist failure.

No raw comparison artifact exists for this issue. The later disposable
diagnostic failure file is not evidence for the paired run because it belongs
to a separate rejected local-server attempt.

## Behavior matrix

| Gate | Issue #1549 live result | Reason |
| --- | --- | --- |
| React lifecycle and host reuse | Unrun | The paired worker produced no receipt. |
| Fixed-height prepend anchor and identity | Unrun | The paired worker produced no receipt. |
| Dynamic-height measurement | Unrun | The paired worker produced no receipt. |
| Tail follow and user-away posture | Unrun | The paired worker produced no receipt. |
| Sticky user-message jump | Unrun | The paired worker produced no receipt. |
| Text selection | Unrun | The paired worker produced no receipt. |
| Scroll to an unmounted message | Unrun | The paired worker produced no receipt. |
| Thread-switch anchor restore | Unrun | The paired worker produced no receipt. |
| Off-screen retained state | Unrun | The paired worker produced no receipt. |

The existing issue #1548 report records earlier Electron evidence for the
lifecycle and fixed-height prepend subset. It does not certify this complete
matrix.

## Bounded worker safeguard

The performance fixture now limits one lifecycle page evaluation to 15 seconds.
If a reached probe never settles, the worker rejects with
`vlist lifecycle probe did not settle within 15000 ms` and writes its normal
failure receipt. This is a runner reliability safeguard. It did not trigger in
the paired attempt because that run did not reach a trustworthy page-evaluation
boundary.

The focused regression command is:

```powershell
bun test scripts/agent/__tests__/frontend-performance-runner.test.mjs
```

It first failed while the bounded evaluator was absent. After the safeguard was
added, it passed 23 tests in 0.18 seconds. The test supplies a page evaluation
that never settles and requires the exact bounded error.

## Required next condition

Before retrying eligibility, the paired runner must produce a valid result JSON
and `.complete` receipt for one standalone-web `vlistLifecycle` sample from the
same Electron-as-Node worker host. Then rerun the three-sample profiling matrix
for standalone web and Electron. Only if every behavior gate passes may a
matched decision-grade timing run begin.
