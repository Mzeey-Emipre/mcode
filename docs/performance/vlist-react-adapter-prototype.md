# vlist React adapter prototype

## Scope

This is a development-only Route B lifecycle probe. One React root portals stable logical row keys into hosts created, laid out, and recycled by vlist. The probe sets `overscan: 0` to make host reuse deterministic. It does not alter the production TanStack message list, add a retained-row cache, or provide a performance comparison.

## Frozen baseline

| Package | Version | Published | Source revision |
| --- | --- | --- | --- |
| `vlist` | 2.6.1 | 2026-07-15 | [`7c39284b964a4d4e7b67821d17a622cf599eaed8`](https://github.com/floor/vlist/tree/7c39284b964a4d4e7b67821d17a622cf599eaed8) |
| `vlist-react` | 2.6.0 | 2026-07-08 | [`4f8a94334f32386b4921dfd8384368506c24f8d3`](https://github.com/floor/vlist-react/tree/4f8a94334f32386b4921dfd8384368506c24f8d3) |

The vlist-react wrapper creates a vanilla vlist instance in a React effect and updates its items. It does not define React-owned virtual rows. [Source](https://github.com/floor/vlist-react/blob/4f8a94334f32386b4921dfd8384368506c24f8d3/src/index.ts#L42-L104)

## Browser observation

The maintained frontend renderer fixture ran the explicit-only `vlistLifecycle` workload in profiling mode with three samples per runtime. Raw output is in `.dev/verification/performance/issue-1548-vlist-lifecycle.json`.

| Runtime | A, B, A samples | Runner-derived assertions | Harness result | Candidate gate |
| --- | --- | --- | --- |
| Standalone Chromium | 3 of 3 | All passed | Accepted | Rejected with the expected host-detachment condition |
| Electron | 3 of 3 | All passed | Accepted | Rejected with the expected host-detachment condition |

The expected condition was identical in every sample: `vlist detached the active React portal target before React ran the row cleanup.`

The runner ignores probe summaries and derives the assertions from raw rendered rows, values, focus state, portal snapshots, transitions, and event traces. The assertions cover heterogeneous logical rows, stable A/B/A identity, local state isolation, effect cleanup counts, ref identity, document-body portal cleanup, focus, controls, and control dispatch. They also require unchanged static rows to keep the same body portal hosts, effects, and refs until final disposal. They confirm that the same vlist pool item is reused before React receives the old row cleanup.

The raw artifact records `gateDecision` for each runtime. Its machine-readable rejection is `{"status":"rejected","candidateEligible":false,"reason":"vlist detached the active React portal target before React ran the row cleanup."}`. After writing and printing that artifact, the explicit `vlistLifecycle` command exits with status 1. That expected status means the candidate was rejected. It does not mean the behavior harness failed.

Timing fields in the raw artifact are intentionally ignored. This probe makes no latency, throughput, memory, or decision-grade performance claim.

## Gate matrix

| Gate | Status | Evidence |
| --- | --- | --- |
| React portal lifecycle under vlist host reuse | Rejected | Both real-browser runtimes observed the exact deterministic host-detachment condition after behavioral assertions passed. |
| Dynamic-height measurement | Not run | The lifecycle gate rejected before the full behavior harness. The autosize path is a separate plugin and has not been integrated. [Source](https://github.com/floor/vlist/blob/7c39284b964a4d4e7b67821d17a622cf599eaed8/src/plugins/autosize/plugin.ts) |
| Prepend anchor preservation | Not run | The lifecycle gate rejected before the full behavior harness. Core `prependItems` updates item storage and rerenders, with no application-level reading-anchor proof in this probe. [Source](https://github.com/floor/vlist/blob/7c39284b964a4d4e7b67821d17a622cf599eaed8/src/core/create.ts#L756-L791) |
| Sticky user-message jump behavior | Not run | The lifecycle gate rejected before the full behavior harness. vlist sticky support is for group headers, not the MessageList sticky-user contract. [Source](https://github.com/floor/vlist/blob/7c39284b964a4d4e7b67821d17a622cf599eaed8/src/plugins/groups/plugin.ts) |
| Full selection and focus integration | Not run | The probe verifies focused inputs and controls only. It does not integrate the vlist selection plugin with message-list selection semantics. [Source](https://github.com/floor/vlist/blob/7c39284b964a4d4e7b67821d17a622cf599eaed8/src/plugins/selection/plugin.ts) |
| Arbitrary retained-row range | Does not fit the core model | Core rendering calculates one contiguous visible range plus overscan. It has no API for an unrelated retained range. [Source](https://github.com/floor/vlist/blob/7c39284b964a4d4e7b67821d17a622cf599eaed8/src/core/pipeline.ts#L225-L265) |
| Production integration and comparison | Not run | Stopped after lifecycle rejection. The production TanStack route is unchanged. |

## Cause

The core pipeline clears the existing pooled item before appending the new template result when an item identity changes. [Pipeline source](https://github.com/floor/vlist/blob/7c39284b964a4d4e7b67821d17a622cf599eaed8/src/core/pipeline.ts#L312-L340) Releasing a pooled element also clears its text content. [Pool source](https://github.com/floor/vlist/blob/7c39284b964a4d4e7b67821d17a622cf599eaed8/src/core/pool.ts#L12-L50) In the portal topology, this detaches the active React portal target before React can reconcile and clean up the old row.

The rejection is therefore a lifecycle incompatibility for the tested Route B topology, not a performance result. No full behavior harness or production migration should proceed from this probe.
