# Conversation residency certification

## Run the certification

Run this command from the repository root:

```sh
bun run certify:conversation --output .dev/verification/conversation-certification.json
```

The command uses Electron's Node runtime. It measures the production byte policy with 100-message and 1,000-message histories. Each message contains 16,000 content bytes and the retained application fields.

The report contains these resident byte classes:

- Active conversation
- Inactive conversation
- Prefetched history
- Narrative metadata

The report also contains the process RSS, heap, and external memory before and after each history. These process values include Vite-node and the certification fixture. Compare reports only on the same runtime and computer.

## Result

The certification passed on 2026-08-11 with Electron 35.7.5 and Node 22.16.0 on Windows x64.

| History | Retained message bytes | Active bytes | Inactive bytes | Prefetched bytes | Narrative bytes | RSS before | RSS after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 messages | 1,623,234 | 1,641,528 | 1,641,528 | 1,625,210 | 17,800 | 167,600,128 | 191,545,344 |
| 1,000 messages | 16,236,286 | 1,642,052 | 1,642,052 | 1,625,628 | 17,904 | 191,545,344 | 243,363,840 |

All resident byte classes stayed below their automatic budgets. The 1,000-message source history was 16,236,286 bytes. The active resident record stayed at 1,642,052 bytes.

## Conversation revision decision

The former guard serialized all retained conversation fields for each comparison. The 1,000-message profile used 10 samples.

| Guard | Bytes per read | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Full-state serialization | 16,426,605 | 66.90 ms | 79.27 ms | 120.59 ms |
| Numeric revision | 0 serialized | 0.000029 ms | 0.000032 ms | 0.000173 ms |

The serialized allocation exceeded the 1 MiB material-cost threshold. Thus, the production hydrator now uses the numeric conversation revision. One owned record patch advances the revision once, even when the patch changes multiple conversation fields.

## Behavior coverage

The maintained test suites cover the certification scenarios.

| Scenario | Maintained test |
| --- | --- |
| Initial load and repeated movement in both directions | `thread-hydrator.test.ts`: `moves a bounded resident window backward and forward without gaps or duplicates` |
| Thread switching and thread isolation | `thread-hydrator.test.ts`: `does not commit stale RPC results after a cross-thread race` |
| Overlapping requests and cancellation | `conversation-residency.test.ts`: `owns overlapping page requests independently by complete thread identity` and `cancels another thread's page request when selection changes` |
| Live arrival, invalidation, and late responses | `pagination.test.ts`: the late older-page and late newer-page tests; `thread-hydrator.test.ts`: the invalidated tail test |
| Visible identity and pixel offset | `MessageList.thread-switch.test.tsx`: the prepend, newer replacement, and pressure-removal offset tests |
| Byte budgets and pressure order | `record-cache.test.ts`: the active, inactive, prefetch, narrative, and critical-pressure tests |

Run the focused suites with this command:

```sh
cd apps/web
bun run test -- src/stores/thread-record.test.ts src/performance/conversation-residency-certification.test.ts src/lib/thread-hydrator/__tests__/thread-hydrator.test.ts src/__tests__/pagination.test.ts src/__tests__/conversation-residency.test.ts src/__tests__/record-cache.test.ts src/components/chat/__tests__/MessageList.thread-switch.test.tsx
```

Use the Electron application for the final visible scroll and thread-switch check. Record the screenshot, message identity, pixel offset, and renderer errors under `.dev/verification/`.

## Live Electron result

The clean Electron build used the isolated runtime database and the same 100-message and 1,000-message fixtures.

- Two upward page insertions kept message 901 and then message 851 at 108 px. Both insertions caused 0 px drift.
- Repeated downward paging reached message 950 and then restored message 1000.
- A 500 ms transport delay kept an older request in flight during a switch to the 100-message thread.
- The switched view contained only `conversation-certification-100` message identities.
- The restored view contained only `conversation-certification-1000` message identities and kept the older reading position.
- The virtual timeline rendered from 2 through 19 message rows during the run. It did not mount the full history.
- The warmed renderer reported 69,753,433 used JavaScript heap bytes on the 100-message thread and 74,627,869 bytes on the 1,000-message thread.
- The final diagnostic interval contained no renderer console errors and no failed requests.

The screenshot is `.dev/verification/conversation-long-history.png`. It shows the restored 1,000-message thread at messages 850 and 851.
