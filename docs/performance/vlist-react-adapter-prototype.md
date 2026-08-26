# vlist React adapter prototype

## Scope

This development-only probe tests an architectural bridge between React and vlist. One React root portals logical rows into hosts that vlist owns.

The bridge uses a vlist plugin with priority `100`. It performs these operations:

1. `onCalculate` removes outgoing React rows before vlist changes the DOM.
2. `onCalculate` parks retained portal hosts when their logical rows move to new indices.
3. vlist updates and recycles its item shells.
4. `onCommit` moves parked hosts into their new shells and renders the visible React rows.
5. The adapter unmounts React before it destroys vlist.

The probe uses `overscan: 0` and fixed 84-pixel rows. It does not change the production TanStack message list or compare performance.

## Frozen baseline

| Package | Version | Published | Source revision |
| --- | --- | --- | --- |
| `vlist` | 2.6.1 | 2026-07-15 | [`7c39284b964a4d4e7b67821d17a622cf599eaed8`](https://github.com/floor/vlist/tree/7c39284b964a4d4e7b67821d17a622cf599eaed8) |
| `vlist-react` | 2.6.0 | 2026-07-08 | [`4f8a94334f32386b4921dfd8384368506c24f8d3`](https://github.com/floor/vlist-react/tree/4f8a94334f32386b4921dfd8384368506c24f8d3) |

The vlist-react wrapper creates a vanilla vlist instance in a React effect and updates its items. It does not define React-owned virtual rows. [Source](https://github.com/floor/vlist-react/blob/4f8a94334f32386b4921dfd8384368506c24f8d3/src/index.ts#L42-L104)

## Browser observation

The Electron renderer ran three profiling samples. The run wrote disposable raw output to `.dev/verification/performance/issue-1548-vlist-lifecycle-bridge-prepend-electron.json`. Repository policy keeps live verification artifacts under the ignored `.dev/verification/` directory. The raw file is not part of this document. See [ADR 0017](../adr/0017-separate-maintained-tests-from-disposable-verification.md).

Run this command to create a new local artifact:

```powershell
bun run perf:frontend -- --mode profiling --sample-count 3 --workload vlistLifecycle --runtime electron --output .dev/verification/performance/issue-1548-vlist-lifecycle-bridge-prepend-electron.json
```

All three samples returned this decision:

```json
{"status":"accepted","candidateEligible":true,"reason":null}
```

The runner derives the decision from raw browser facts. It does not trust a summary from the probe.

The lifecycle checks cover heterogeneous rows, local state, effects, refs, body portals, focus, controls, and host reuse. The checks also cover native scroll recycling and final disposal.

The prepend check inserts two older rows above a visible anchor. In each sample, the anchor stayed at pixel `774`. Its edited draft stayed `edited-before-prepend`. Its effect and ref counts stayed at one. Its React portal host token stayed `portal-host-0`.

The standalone Chromium process failed to start twice within its 180-second limit. Later Electron profiles also failed during app startup. Those failures occurred before probe code ran.

The runner ignores timing fields for this workload. This probe makes no performance claim.

## Gate matrix

| Gate | Status | Evidence |
| --- | --- | --- |
| React portal lifecycle under vlist host reuse | Passed in Electron | Three samples show React cleanup before vlist detaches the old host. Native scroll also recycles pool shells. |
| Fixed-height prepend anchor and logical identity | Passed in Electron | Three samples keep the anchor position, draft, mount count, ref count, and portal host. |
| Dynamic-height measurement | Not run | The fixed-height prepend bridge does not prove the autosize path. [Source](https://github.com/floor/vlist/blob/7c39284b964a4d4e7b67821d17a622cf599eaed8/src/plugins/autosize/plugin.ts) |
| Tail follow and user-away posture | Not run | No browser artifact covers append behavior after the bridge change. |
| Sticky user-message jump | Not run | vlist sticky support covers group headers, not the MessageList contract. [Source](https://github.com/floor/vlist/blob/7c39284b964a4d4e7b67821d17a622cf599eaed8/src/plugins/groups/plugin.ts) |
| Selection and scroll-to-message | Not run | The probe covers focus and controls only. |
| Thread-switch anchor restore | Not run | No browser artifact covers per-thread anchor storage after the bridge change. |
| Arbitrary retained-row range | Does not fit the core model | Core rendering calculates one contiguous visible range plus overscan. It has no API for an unrelated retained range. [Source](https://github.com/floor/vlist/blob/7c39284b964a4d4e7b67821d17a622cf599eaed8/src/core/pipeline.ts#L225-L265) |
| Equivalent retained-state mechanism | Not run | The bridge can keep moved visible hosts, but it does not prove an off-screen retained-state design. |
| Production integration and comparison | Not run | The production TanStack route is unchanged. |

## Architectural result

The original direct-portal topology failed because vlist detached the portal target before React cleanup. The bridge changes that ownership handoff. React now removes outgoing rows before vlist updates its shells.

Prepend needs more work than cleanup order. vlist keys rendered shells by index. The bridge parks retained portal hosts, shifts the pending fixed-height range, and restores each host under its new index. This keeps the React component mounted.

The tested bridge removes the original lifecycle rejection. It also proves fixed-height prepend behavior in Electron. The candidate remains incomplete until the other behavior gates pass.
