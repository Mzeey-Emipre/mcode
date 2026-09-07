# Performance Audit Checklist

Performance principles for building a fast, memory-efficient Electron + React app. Inspired by what high-performance native editors (Zed, Sublime) get right. Use this as a recurring checklist when reviewing code or adding new features.

---

## Performance Change Workflow

Before a performance investigation or implementation, load the repository's
[`performance-engineer` skill](../../.codex/skills/performance-engineer/SKILL.md).
Use this guide as the source of truth for Mcode budgets and verification.

1. Name one user-visible or system-visible critical path and its behavior gates.
2. Record the environment, input, metric, and a specific cause hypothesis.
3. Capture a repeatable baseline before the change. Use multiple samples when the metric is noisy.
4. Attribute the cost before selecting an optimization.
5. Make the smallest change that removes the measured cost.
6. Repeat the same measurement and behavior gates under the same conditions.

### Paired frontend runner

Use the maintained paired runner for chat and panel changes:

Use profiling mode for React commits and narrative-row render counts:

```powershell
bun run perf:frontend -- --mode profiling --sample-count 7 --output .dev/verification/performance/profiling.json
```

Use production mode for Chromium and Electron process data:

```powershell
bun run perf:frontend -- --mode production --sample-count 7 --output .dev/verification/performance/production.json
```

The command starts or reuses the worktree runtime. It builds the selected mode.
It runs the same ordered workloads in standalone web and Electron. Each workload
gets one warmup and the same sample count at a 1440 by 1000 viewport.

Profiling results contain React commits and row counts. Production results
contain Chromium scripting, layout, paint, long-task, and frame-cadence data.
Production Electron results also contain process CPU and memory data from
Electron. A signal that is not available has a `null` value.

Each result contains the build mode, hardware-acceleration state, workload,
warmup count, sample count, raw samples, summary, source revision, environment,
and correctness checks. The command rejects each incorrect sample.

Use this sequence for a performance change:

1. Save a baseline result before you edit product code.
2. Name one measured cause from the baseline or a trace.
3. Make the smallest reversible change that removes that cause.
4. Save the candidate result with the same sample count and environment.
5. Compare accepted raw samples and summary statistics from both files.

Do not compare results when the viewport, fixture order, warmup, sample count,
source mode, hardware-acceleration state, or device changed. Store task results
under `.dev/verification/performance/`.

For frontend and Electron work, keep four signals separate:

| Signal | Measures | Does not prove |
| --- | --- | --- |
| React Profiler | React commits and render duration | Layout, paint, dropped frames, or GPU use |
| Chromium trace | Scripting, layout, paint, long tasks, and frame delivery | React component identity or OS GPU use |
| `app.getAppMetrics()` | Electron process CPU and memory | Hardware GPU utilization |
| OS GPU counters or traces | GPU-engine work attributed to a process | Which React component caused the work |

Record the hardware-acceleration state and keep it fixed within a comparison.
Use a profiling build for React evidence. Use a normal production build without
open DevTools for process and GPU evidence. Store raw evidence under
`.dev/verification/performance/`.

### Packaged Windows acceleration evidence

Run the paired packaged comparison on each Windows GPU class:

```powershell
bun run perf:frontend:packaged-windows -- --gpu-type integrated --adapter-name "Intel(R) Iris(R) Xe Graphics" --sample-count 7 --gpu-sample-count 30 --output .dev/verification/performance/integrated.json
```

Use `--gpu-type discrete` on the discrete-GPU device. Set `--adapter-name` to
the exact adapter name that Windows reports. The runner rejects a name that is
not present. It records the GPU type as an operator classification for that
matched adapter.

The command builds one normal production package. It runs the same warmup,
workload order, sample count, and correctness checks with disabled acceleration
and Electron's default acceleration. DevTools stay closed.

The result keeps frame stability, CPU, memory, React data, and Windows GPU
Engine data separate. A missing or zero attributable GPU counter has the
`inconclusive` status. Do not treat that status as zero GPU use.

Compare integrated and discrete results only when their source revision and
comparison contract match. Store both result files for the hardware policy
decision.

---

## 1. Virtualize All Scrollable Lists

Any list that can grow beyond ~30 items must use virtual scrolling. Only DOM nodes visible in the viewport (plus a small overscan) should exist.

For timelines and other high-churn lists, build the UI as a viewport engine with
fine-grained row subscriptions. A single item, token stream, tool-call status,
or measurement change should update the affected row or segment, not make React
reconcile the whole list. Treat visible range, row measurements, scroll anchors,
and item data as separate concerns so the user keeps their place while the app
does less work.

**Do:**
- Use a virtualizer (`@tanstack/react-virtual`, `react-window`, etc.) for dynamic-length lists
- Set a fixed or estimated item height for the virtualizer
- Add overscan (2-5 items) for smooth scrolling
- Subscribe rows to the smallest stable data slice they need
- Preserve scroll anchors when items are prepended, resized, or streamed

**Don't:**
- Render all items with `.map()` inside a scrollable container
- Rely on `max-height` + `overflow-y: auto` as a substitute for virtualization
- Assume a list will stay small forever
- Replace whole arrays or parent objects for updates that affect one row

**How to verify:**
- Open React DevTools, inspect a scrollable container, scroll to the bottom. DOM node count should stay constant regardless of list length.
- Chrome DevTools Performance tab: DOM node count in any scrollable area should stay under ~500 regardless of data size.
- React DevTools Profiler: row updates should be limited to changed rows or the active streaming row.

---

## 2. Memoize Expensive Components

Components inside frequently-updating parents should be wrapped in `React.memo()`. Expensive render logic (markdown parsing, syntax highlighting, computed layouts) should use `useMemo`.

**Do:**
- Wrap list item components in `React.memo()` so they skip re-rendering when their props haven't changed
- Use `useMemo` for expensive transformations (e.g. markdown-to-HTML parsing)
- Use `useCallback` for event handlers passed as props to memoized children

**Don't:**
- Let a parent re-render cause every child in a list to re-render
- Re-parse markdown or re-run syntax highlighting on every render when the source text hasn't changed
- Recreate component config objects (e.g. custom renderers) inside render

**How to verify:**
- React DevTools Profiler: record a session, trigger a state change, check "Why did this render?" on sibling items. They should show "Did not render" if their props didn't change.

---

## 3. Keep IPC Lean (Electron Main <-> Renderer)

Every `ipcRenderer.invoke()` serializes and deserializes JSON. Minimize the frequency and size of IPC calls.

**Do:**
- Batch related data into a single IPC call instead of multiple small ones
- For high-frequency streaming data (>60 events/sec), implement a batching window (e.g. 16ms / one frame) before forwarding to the renderer
- Use `MessagePort` or `SharedArrayBuffer` for high-throughput channels (terminal output, streaming responses)
- Enable context isolation and disable node integration
- Validate inputs on all IPC boundaries

**Don't:**
- Send individual IPC messages for every token, keystroke, or terminal byte
- Pass large objects (full file contents, entire conversation history) through IPC when only a delta is needed

**How to verify:**
- Add temporary IPC message counting in the main process during heavy workloads. If sustained >100 messages/sec, implement batching.

---

## 4. Lazy-Load Heavy Modules and Panels

Only load what's needed at startup. Defer everything else until the user needs it.

**Do:**
- Use `React.lazy()` + `Suspense` for panels and views not visible on initial render (settings, terminal, secondary tabs)
- Dynamic `import()` for heavy libraries only used in specific features (terminal emulators, markdown parsers, diagram renderers)
- Code-split at route/panel boundaries

**Don't:**
- Eagerly import large libraries at module level if they're only used conditionally
- Load all features at startup "just in case"
- Ship a single monolithic JS bundle

**How to verify:**
- Run a bundle visualizer (`rollup-plugin-visualizer`, `webpack-bundle-analyzer`). No single eagerly-loaded chunk should exceed 500KB.
- Track startup time: measure time from `app.ready` to first meaningful paint.

---

## 5. Avoid Layout Thrashing

Never interleave DOM reads and DOM writes. Batch all reads first, then all writes.

**Do:**
- Read layout properties (`scrollHeight`, `getBoundingClientRect`, `offsetWidth`) before making any style changes
- Use `requestAnimationFrame` to defer writes to the next frame if reads and writes can't be separated
- Use CSS for auto-sizing where possible (e.g. `field-sizing: content` for textareas)

**Don't:**
- Write a style, immediately read a layout property, then write again (e.g. `height = "auto"` -> read `scrollHeight` -> write `height`)
- Call `getBoundingClientRect()` in a loop that also modifies styles
- Trigger forced synchronous layouts inside scroll or resize handlers

**How to verify:**
- Chrome DevTools Performance tab: record interactions, look for repeated purple "Layout" bars >1ms. These indicate forced reflows.

---

## 6. Use Fine-Grained Store Selectors

When using state management (Zustand, Redux, etc.), components should subscribe to the smallest slice of state they need.

**Do:**
- Use selectors: `useStore((s) => s.specificField)`
- Split stores by domain (settings, threads, UI state) rather than one mega-store
- Derive computed values with selectors, not in components

**Don't:**
- Subscribe to the entire store: `useStore()` with no selector
- Subscribe to a parent object when you only need one field
- Trigger re-renders in unrelated components by mutating shared objects

**How to verify:**
- `grep` for bare store hook calls without selector arguments. Every usage should have `(s => ...)`.
- React DevTools Profiler: after a state change, only components that use the changed field should re-render.

---

## 7. Stream Responses Efficiently

For AI/LLM response streaming, accumulate text on the backend and send complete snapshots to the renderer. Avoid token-by-token DOM updates.

**Do:**
- Accumulate streamed tokens into a buffer on the backend/main process
- Send the full accumulated text (or meaningful deltas) to the renderer at a throttled rate
- Use immutable state updates (spread into new array) for message lists

**Don't:**
- Forward every individual token as a separate event to the renderer
- Concatenate strings in a loop on the renderer side (creates GC pressure)
- Re-render the entire message list on every token

**How to verify:**
- During streaming, measure time per state update in the store. Each update should be <2ms.
- Check that only the actively-streaming component re-renders, not all siblings.

---

## Scoring Guide

When running this audit, score each category:

| Score | Meaning |
|-------|---------|
| Pass | Meets the principle across all relevant code |
| Warning | Mostly good, but has known gaps that don't yet cause measurable issues |
| Fail | Measurable performance impact, needs a fix |

---

## Related

- Performance issues are tracked on GitHub with the `perf` label
- Run this checklist before major releases and after adding new list-based UI or heavy features

## Pull Request Review Gate

Run the production gate from `apps/web`:

```bash
bun run perf:pull-requests
```

The command builds the web app, checks the Vite manifest, and runs the selector
p95 and layout-rule Vitest files. The test fixtures use only fake GitHub
transport responses and must not send a real comment, review, readiness change,
close, or merge.

The fixture stays within every wire bound:

- 1,000 inbox rows arrive through 34 calls of at most 30 rows.
- 1,000 Timeline events arrive through 34 calls of at most 30 events.
- 500 changed files arrive through five calls of at most 100 files.
- One patch contains 20,000 parsed lines and uses one patch call.

Each viewport must keep fewer than 500 descendants. Inbox, Timeline, file, and
patch requests use fixed page counts so an N+1 read fails the test. Selector and
store-update p95 stays below 2 ms.

The manifest walk starts at each application entry and follows static imports
only. Every eager chunk must be at most 500 KiB gzip. Pull request Surface, Code,
and remote Markdown remain dynamic entries.

Chrome trace analysis marks a Layout over 1 ms as slow. One bounded jump may
contain at most two slow layouts, and no two may start within the same 16.7 ms
frame window. Three separated slow layouts still fail. Any main-thread task over
50 ms fails.

## Packaged Server Startup

Electron packaging compiles `apps/desktop/dist/server/server.cjs` into the
`resources/bin/mcode-bun` executable with `bun build --compile --bytecode`.
This affects the packaged server only. Development starts that run
`bun apps/desktop/dist/server/server.cjs` do not use the compiled bytecode.

[`--bytecode`](https://bun.sh/docs/bundler/executables#bytecode-compilation)
moves JavaScript parsing work from runtime to bundle time. On source revision
`4e971f7eda98536400f7aadc66f97704ca996d76`, Bun 1.4.1 on Windows x64, nine
interleaved baseline and bytecode pairs measured median authenticated-RPC startup
times of 1609.0 ms and 834.4 ms. The baseline range was 1069.0 to 3736.7 ms;
the bytecode range was 493.5 to 2280.2 ms.

The metric runs from spawning a fresh Bun process until an authenticated
`workspace.list` RPC completes. Both binaries use copies of one immutable,
migrated fixture database with one fixture workspace and no user projects.
The benchmark runs with `NODE_ENV=development`. It measures the compiled Bun
server binary, not startup of the packaged Electron application or behavior on
other target platforms.

The receipt requires a `/health` body with `status: "ok"` and numeric
`activeAgents`, one `workspace.list` result whose path is the fixture repository,
and a zero server exit code. The runner writes the receipt to
`.dev/verification/performance/server-startup/<output>/baseline.json`.
The interleaved session receipt is
`.dev/verification/performance/server-startup/interleaved-9-pairs-corrected/interleaved.json`.
