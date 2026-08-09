# Frontend performance baseline

Issue: [Measure the current Electron and web frontend performance baseline](https://github.com/Mzeey-Empire/mcode/issues/1240)

Commit under test: `b56e8dda`

Date: 2026-08-09

## Result

The current message timeline keeps 100 and 1,000-message fixtures to 12 to 14 mounted messages. It does not meet the 50 ms first-load target in either runtime. Electron is also slower than standalone web for every renderer transition in this matrix.

The dense narrative fixture is the clearest structural failure. A turn with 60 tools, 20 narration segments, and 10 hooks rendered 1,297 descendants. The current budget permits fewer than 500 descendants per virtualized view.

The pull-request selector and eager-chunk gates pass. The largest eager chunk is 156,222 gzip bytes against a 512,000-byte limit. The Shiki worker is lazy, but its uncompressed file is 1,995,090 bytes.

## Environment

| Item | Value |
| --- | --- |
| OS | Windows |
| CPU | Intel Core i7-1255U, 10 cores, 12 logical processors |
| Memory | 23.6 GiB |
| Bun | 1.3.11 |
| Electron | 35.7.5 |
| Standalone browser | Chrome 151.0.7922.76, headless |
| Virtualizer | `@tanstack/react-virtual` 3.13.23 |
| Runtime | Worktree-local development server from `bun run --shell system agent:up` |
| Viewport | 1440 by 1000 CSS pixels |

These measurements use the development runtime. Use them for same-machine comparisons between the baseline and prototypes. They are not release-build startup or memory certification.

## Fixture contract

Run [`scripts/perf/frontend-renderer-fixture.mjs`](../../scripts/perf/frontend-renderer-fixture.mjs) against both pages through Playwright. Warm each path once. Record at least three timed samples.

| Fixture | Input | Correctness check |
| --- | --- | --- |
| Message load | 100 alternating user and assistant messages, 30 repeated words per message | Store count is 100; mounted message count stays bounded |
| Large message load | 1,000 messages with the same shape | Store count is 1,000; mounted message count stays bounded |
| Thread switch | Two resident threads with 1,000 messages each | Workspace, conversation, and visible message thread IDs match |
| Streaming | 200 final-response text deltas in one frame window | Accumulated length equals 1,890 characters |
| Dense narrative | 60 tools, 20 narration segments, and 10 hooks on one assistant turn | Tool and narration text is visible; count all list descendants |
| Markdown and Shiki | 10 TypeScript fences with 100 lines each | All 10 code blocks receive `.shiki` output |
| Browser and Terminal panels | Open Browser, then switch to Terminal | Both tabs stay open; Terminal is active; its pool slot exists |

The runner changes only renderer stores. It does not create provider turns, terminal processes, GitHub requests, or database rows.

## Renderer results

Values are milliseconds. Each row contains three warm samples.

| Fixture | Standalone min | Standalone median | Standalone max | Electron min | Electron median | Electron max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 messages | 725.4 | 825.4 | 825.7 | 2,062.0 | 2,188.7 | 2,341.3 |
| 1,000 messages | 633.8 | 652.1 | 766.5 | 2,209.0 | 2,248.5 | 2,375.9 |
| Thread switch | 657.1 | 704.5 | 745.7 | 2,268.9 | 2,407.0 | 2,423.7 |
| 200 streaming deltas | 446.7 | 594.6 | 597.1 | 1,804.3 | 1,835.8 | 1,852.3 |
| Dense narrative | 403.4 | 613.4 | 652.2 | 2,059.0 | 2,076.6 | 2,203.0 |
| Markdown and Shiki | 1,136.1 | 1,441.9 | 1,494.3 | 2,124.7 | 2,354.4 | 2,406.6 |
| Browser to Terminal | 192.3 | 257.4 | 265.3 | 615.7 | 654.4 | 800.1 |

The 100-message and 1,000-message views mounted 12 to 14 messages. Their message-list descendant counts stayed between 296 and 345. The dense narrative view rendered 1,297 descendants because one virtual item contains the full narrative turn.

The standalone matrix ended at 81.3 MB of used JavaScript heap. The Electron matrix ended at 130.0 MB. These values include the cumulative matrix, not an idle snapshot.

Both runtimes produced many tasks above 50 ms. Standalone tasks reached 995 ms. Electron tasks reached 3,216 ms. No console errors or page errors occurred.

## Pull-request results

`bun run perf:pull-requests` passed six maintained checks. The build and checks completed in 54,797 ms.

The shared 400-sample probe used 1,000 inbox rows and 500 changed files.

| Selector | Standalone p95 | Electron p95 | Budget |
| --- | ---: | ---: | ---: |
| Inbox filter | 0.5 ms | 0.6 ms | 2.0 ms |
| Inbox grouping | 0.5 ms | 0.5 ms | 2.0 ms |
| Selection update | 0.1 ms | 0.1 ms | 2.0 ms |
| Code selector | 0.0 ms at timer resolution | 0.0 ms at timer resolution | 2.0 ms |

The maintained viewport check also passed with 500 files, a 20,000-line patch, 18 mounted rows, and fewer than 500 descendants.

## Startup and memory

The renderer-visible reload probe used five samples.

| Runtime | Min | Median | Max |
| --- | ---: | ---: | ---: |
| Standalone web | 2,524 ms | 3,194 ms | 3,440 ms |
| Electron renderer | 6,979 ms | 9,371 ms | 12,477 ms |

Three clean Electron process starts reached the landing heading in 20,391 ms, 21,991 ms, and 23,726 ms.

The clean Electron development process tree used 1,103.4 MB of working set. The main process used 133.1 MB. Two renderer processes used 243.6 MB and 235.2 MB. The remaining memory belonged to the GPU, network, server, and provider helper processes.

The product targets are less than 2 seconds to usable and less than 150 MB at idle. The development measurements exceed both values. Repeat the checks on a packaged release before treating them as release-budget failures.

## Current budgets

| Budget | Current result |
| --- | --- |
| First 100 messages below 50 ms | Failed in both development runtimes |
| Virtualized view below 500 descendants | Passed for the normal message view; failed for the dense narrative turn |
| Store and selector p95 below 2 ms | Passed for the pull-request probe |
| Eager chunk at most 500 KiB gzip | Passed; largest eager chunk was 156,222 bytes |
| No main-thread task above 50 ms | Failed in both renderer matrices |
| Startup below 2 seconds | Development result exceeded the target; packaged check remains necessary |
| Idle memory below 150 MB | Development process tree exceeded the target; packaged check remains necessary |

## Prototype comparison rule

Compare the current implementation, a targeted current-stack change, and each Legend candidate with the same fixture data, order, viewport, warmup, and sample count. Record correctness first. Reject a candidate if it changes scroll anchors, visible thread identity, streaming text, narrative order, highlighted block count, panel state, accessibility, or eager chunks.

Use median and maximum for renderer transitions. Use p95 for store and selector loops. Do not claim an improvement from one run.
