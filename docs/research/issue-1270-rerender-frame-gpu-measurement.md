# Rerender, frame, and GPU measurement

Issue: [#1270](https://github.com/Mzeey-Empire/mcode/issues/1270)<br>
Decision blocked: [#1243](https://github.com/Mzeey-Empire/mcode/issues/1243)

## Result

Mcode needs four separate signals. A React rerender is not proof of a dropped frame or GPU work. GPU work can also come from Chromium composition, a Browser guest, CSS animation, video, canvas, or frame swaps. The test must attribute each cost before an optimization proceeds.

Use two passes over the same fixture:

1. Use a production profiling build and a Chromium trace for React and frame evidence.
2. Use a normal production build without open DevTools for process and Windows GPU evidence.

Do not disable hardware acceleration as a performance fix. Current source already calls `app.disableHardwareAcceleration()` before `ready` in [`apps/desktop/src/main/main.ts`](../../apps/desktop/src/main/main.ts#L822-L825). Its comment says that Mcode only renders text and Markdown. That premise is stale because Mcode now hosts Browser `<webview>` surfaces. The Terminal also has a conditional WebGL path, although [`shouldUseWebglRenderer`](../../apps/web/src/components/terminal/TerminalView.tsx#L179-L185) selects the DOM renderer in Electron. Wayfinder must first decide the intended acceleration contract. Every result must record `app.isHardwareAccelerationEnabled()` after `gpu-info-update`. Do not compare runs with different values.

## Four signals

| Signal | Capture | What it proves | What it does not prove |
| --- | --- | --- | --- |
| React render count and duration | Add bounded `<Profiler>` scopes around `MessageList`, `NarrativeFlow`, the active narrative row, `MessageBubble`, Browser panel, and Terminal panel. Record `id`, `phase`, `actualDuration`, `baseDuration`, `startTime`, and `commitTime`. Add fixture-only row counters. | Commit count and React CPU time for each scope. Shared `commitTime` groups scopes in one commit. `actualDuration` against `baseDuration` shows memoization effect. | DOM layout, paint, presentation, dropped frames, compositor cost, GPU load, or power. The profiler adds overhead and normal production builds disable it. See the official [React Profiler reference](https://react.dev/reference/react/Profiler). |
| Browser main thread and frame cadence | Capture a Chromium Performance trace plus `requestAnimationFrame` timestamps for foreground cases. Record scripting, style, layout, paint, long tasks, frame duration, partial frames, dropped frames, and trace loss. | Main-thread cost, frame delivery, and whether a stall is in script, layout, paint, or later frame stages. Chrome marks partial and dropped frames in the Frames track. | React component identity without React marks, Windows GPU percentage, GPU power, or a stable list from `Performance.getMetrics`. See the [DevTools Performance reference](https://developer.chrome.com/docs/devtools/performance/reference/), [CDP Tracing](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/), and [Chromium frame pipeline](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/life_of_a_frame.md). |
| Electron process CPU and memory | Poll `app.getAppMetrics()` after one priming sample. Record every `pid`, `creationTime`, `type`, `cpu.percentCPUUsage`, `cpu.cumulativeCPUUsage`, and memory field. Map each target `webContents` with `getOSProcessId()`. | CPU and memory for Electron's Browser, Tab, Utility, and GPU processes. `pid` plus `creationTime` protects against PID reuse. | Hardware GPU utilization. `getGPUInfo()` and `getGPUFeatureStatus()` report device and feature state, not load. See [`app.getAppMetrics()`](https://www.electronjs.org/docs/latest/api/app), [ProcessMetric](https://www.electronjs.org/docs/latest/api/structures/process-metric/), and [CPUUsage](https://www.electronjs.org/docs/latest/api/structures/cpu-usage/). |
| Windows GPU-engine utilization | Sample `\GPU Engine(*)\Utilization Percentage` and filter enumerated instances to the captured Electron PIDs. Keep each engine series. | WDDM engine busy time attributed to an Electron OS PID. | A specific React tree, Desktop Window Manager cost, electrical power, temperature, or GPU memory. One-second samples can miss short spikes. |

React documents `memo` as an optimization, not a guarantee. It only skips a parent-driven render when props compare equal. New objects, arrays, and functions defeat the default comparison. A custom comparator must compare every prop and can cost more than the render. Use it only after the profiler identifies repeated, expensive renders with unchanged output. See the official [`memo` reference](https://react.dev/reference/react/memo).

## Repeatable fixture matrix

The issue 1240 fixture defines useful data and correctness checks. It is not present on current `main`. It exists on the research branches as `scripts/perf/frontend-renderer-fixture.mjs`. Implementation must promote or recreate that fixture before it adds issue 1270 fields.

Lock these inputs for all comparisons:

- commit, fixture revision, build type, React profiling flag, Electron and Chromium versions, viewport `1440 x 1000`, device scale factor, zoom, and color scheme;
- machine, CPU, GPU adapter and LUID, driver, WDDM version, display refresh, power mode, foreground state, and other visible applications;
- hardware acceleration state, `backgroundThrottling` state, Browser URL, Terminal renderer, fixture order, and input timing;
- one untimed warmup per scenario, five timed samples per runtime and revision, and a restart between idle or process samples.

Run each workload in standalone web and Electron where the surface exists:

| Scenario | Exact fixture action | Window | Correctness gate |
| --- | --- | --- | --- |
| Scroll | Load 1,000 alternating messages. Scroll from tail to head and back over 10 seconds at a fixed rate. | 15 seconds | Mounted rows stay bounded. Final anchor and tail state match. |
| Streaming deltas | Load 100 messages. Deliver 200 deltas across 200 frame requests, then repeat the existing one-window burst. | 15 seconds | Final text length is 1,890. Only the active response and affected narrative row update. |
| Dense narrative updates | Start with 60 tools, 20 thoughts, and 10 hooks. Apply 60 deterministic progress or completion updates at 16.7 ms intervals. | 15 seconds | Order, lifecycle, keys, counts, and visible text match. Volatile state survives `turn.persisted`. |
| Markdown and Shiki | Render ten TypeScript fences of 100 lines. Wait for all ten `.shiki` nodes. | 15 seconds | All blocks highlight. Text and copy semantics match. |
| Idle foreground | Show a settled 1,000-message thread with no cursor, spinner, loading state, or profiler HUD. | 60 seconds after 5-second settle | No store input occurs. Record any recurring commit, paint, or engine work as a defect lead. |
| Idle background | Use the same view, then minimize the Electron window. Use a hidden browser page for the web control. | 60 seconds after 5-second settle | Visibility and window state match the intended case. Do not use foreground `requestAnimationFrame` cadence as a background metric. |
| Browser visible | Show a deterministic local static page in the Browser panel. Repeat with its page animation fixture active. Keep Terminal closed. | 60 seconds each | The expected tab and URL stay visible. Record the Browser guest renderer PID. |
| Terminal visible | Show one settled Terminal, then run a fixed 10-second output replay. Keep Browser closed. | 60 seconds | Output hash, scroll position, and active renderer match. Electron must report DOM unless the product contract changes. |

Also run Browser and Terminal together because Chromium can share GPU work across surfaces. Use an A/B sequence: chat only, Browser only, Terminal only, then both. `PreviewPerfHud` polls once per second only when `previewPerf=1` in [`PreviewPerfHud.tsx`](../../apps/web/src/components/panels/PreviewPerfHud.tsx#L6-L36). Keep it off in clean cost runs.

Electron's `backgroundThrottling` default is `true`. If one `webContents` in a window disables it, Electron draws and swaps frames for all displayed contents in that window. Record this value and do not change it inside a comparison. See the official [WebPreferences reference](https://www.electronjs.org/docs/latest/api/structures/web-preferences).

### Output contract

Write raw evidence under `.dev/verification/performance/issue-1270/<commit>/<runtime>/<scenario>/<sample>/`:

- `environment.json`: all locked inputs, sanitized executable identities and allowlisted flags, acceleration state, feature status, target `webContents` IDs, PIDs, and creation times. Never record environment values, credentials, URLs with credentials, or full command lines;
- `react-profiler.jsonl`: one record per profiler callback plus fixture-only row identity and changed-state reason;
- `chromium-trace.json.gz`: categories returned by `Tracing.getCategories`, trace events, `dataLossOccurred`, and clock markers;
- `frames.json`: expected refresh interval, rAF timestamps, frame deltas, partial and dropped frame counts, long tasks, layout, paint, and composite totals;
- `electron-processes.jsonl`: timestamp and complete `ProcessMetric` records;
- `windows-gpu-engines.csv`: timestamp, PID, creation time, Electron type, full instance name, adapter LUID, physical adapter, engine index, engine type, and cooked percentage;
- `result.json`: wall time, correctness checks, console errors, page errors, descendant counts, and summaries.

For each scalar, keep raw samples and report `n`, minimum, median, p95, maximum, and median absolute deviation. For A/B work, use paired sample order and report the paired median percentage change. Also report a bootstrap 95% confidence interval for that paired change. Do not claim an improvement if the interval crosses zero. React summaries must include commit count, update count, sum and p95 of `actualDuration`, median `baseDuration`, changed-row renders, and unchanged-row renders. Frame summaries must include p95 and maximum frame interval, partial-frame ratio, dropped-frame ratio, long-task count, and maximum task duration. Process and GPU summaries must remain split by PID and process type.

## Windows GPU attribution

There is no portable Electron API for GPU percentage. Use this Windows method:

1. Capture `app.getAppMetrics()`. Keep `pid`, `type`, and `creationTime`. Capture target renderer PIDs with `webContents.getOSProcessId()`.
2. Enumerate the local counter set. Do not construct instance names:

   ```powershell
   Get-Counter -ListSet 'GPU Engine' | Select-Object -ExpandProperty PathsWithInstances
   ```

3. Sample all engines for the fixed 60-second scenario:

   ```powershell
   Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples 60
   ```

4. Filter `CounterSamples.InstanceName` to enumerated instances whose `pid_<PID>` token matches a captured Electron PID. Validate the token format on each host. Microsoft does not document that instance string as a stable contract.
5. Keep every engine series. For a Task Manager-equivalent per-process summary, select the busiest engine at each timestamp. Do not sum parallel engines. Microsoft's DirectX team documents the [busiest-engine rule](https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/).

`Get-Counter` supports instance enumeration, wildcard paths, sample intervals, and sample counts. Counter names are localized, and some sets need elevated access. See the official [`Get-Counter` reference](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.diagnostics/get-counter).

Limitations:

- WDDM 2.0 or newer is necessary for the Task Manager GPU data path.
- The Electron GPU PID can combine work from all app surfaces. Desktop Window Manager owns final desktop composition outside that PID.
- A one-second counter misses short spikes. Multiple adapters and hybrid-GPU changes can move work to another LUID.
- Busy percentage is not power or energy. Do not describe it as battery cost without a separate energy measurement.

If the counter set, access, or PID attribution is unavailable, mark GPU percentage as unavailable. Do not replace it with `getGPUInfo()`. Capture a 30 to 60-second WPR GPU Activity or GPUView ETW trace. GPUView reads video and kernel ETW events and shows process and GPU queues. See Microsoft's [GPUView overview](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/using-gpuview), [trace procedure](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/generating-a-trace-for-gpuview), and [WPR GPU Activity profile](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/built-in-recording-profiles). If ETW is also unavailable, report only Electron CPU and memory plus Chromium frame evidence. Make no GPU-utilization claim.

A read-only probe on the current machine queried 30 Mcode or Electron PIDs for five one-second samples. It found no non-zero engines. This proves only that the counter query works and that the contaminated idle snapshot did not reproduce the report. It does not establish a zero-GPU baseline.

## Ranked hotspots and safe seams

### 1. Narrative rows

[`NarrativeFlow`](../../apps/web/src/components/chat/narrative/NarrativeFlow.tsx#L129-L218) rebuilds the full item list when any narrative array or stream string changes. It then filters and maps all timeline rows. The dense issue 1240 fixture rendered 1,297 descendants. Issue 1242 measured median row renders of 236 for current code and 120 for a targeted Zustand prototype. Legend-State reached 350.

Smallest safe seam: add one memoized `NarrativeRow` with stable scalar props and exact row data references. Keep `NarrativeFlow` as the lifecycle and ordering owner. First prove that completed sibling rows receive unchanged props. Preserve the current keys, accessibility, entry animation, subagent nesting, and `turn.persisted` lifetime.

### 2. Narrative derivation

[`buildNarrativeItems`](../../apps/web/src/components/chat/narrative/build-narrative.ts#L125-L333) reconstructs the timeline, sorts it, scans children, and filters Agent hooks for each subagent lifecycle row. Its direct production callers are `NarrativeFlow` and `virtual-items`.

Smallest safe seam: precompute bounded child and hook indexes once per build. Add structural sharing only if the profiler shows derivation or prop identity as a material cost. Preserve chronological order, counts, parent attribution, final-response classification, and stable keys. Do not move authority out of Zustand.

### 3. Message list measurement and scroll work

[`MessageList`](../../apps/web/src/components/chat/MessageList.tsx#L339-L388) subscribes to separate resident record slices. Its builders reconstruct volatile virtual items on narrative changes. [`useVirtualizer`](../../apps/web/src/components/chat/MessageList.tsx#L803-L846) uses dynamic measurement, eight-row overscan, and custom scroll compensation. Tail and history logic reads layout during scroll and settle loops.

Smallest safe seam: retain TanStack Virtual and the current adapter. Compare a targeted `useAnimationFrameWithResizeObserver` measurement option only after traces attribute frame loss to ResizeObserver or measurement churn. Preserve prepend anchors, thread restoration, streaming tail behavior, sticky preview, bounded residency, and accessibility.

### 4. Surface and animation composition

Browser pages remain mounted under [`BrowserSurfaceHost`](../../apps/web/src/services/browser-surfaces/BrowserSurfaceHost.ts). Mcode CSS contains finite and infinite animation paths, including the caret, preview loading bar, spinners, pulses, and plan skeletons in [`index.css`](../../apps/web/src/index.css). Many have reduced-motion overrides. These are compositing leads, not proof of high GPU use.

Smallest safe seam: use the idle matrix to identify an animation or frame producer that remains active when its state is not visible. Stop only that producer at the visibility or lifecycle boundary. Do not remove user-visible progress, reduced-motion behavior, Browser warmth, Terminal state, or hardware acceleration without a separate product decision.

## Acceptance and regression budgets

Correctness gates are absolute:

- Preserve TanStack Virtual, Zustand conversation authority, bounded conversation residency, narrative lifecycle, chronological order, scroll anchors, thread identity, streaming text, Shiki output, panel state, Terminal output, keyboard behavior, and accessibility.
- Keep fewer than 500 descendants in each normal virtual viewport. The dense narrative case needs a separate design decision because one narrative virtual item currently exceeds this budget.
- Keep every main-thread task at or below 50 ms. This existing guide budget currently fails, so the first implementation must improve it and must not hide the failure.
- Produce no console error, page error, React warning, lost trace event, or lost GPU counter sample.

The repo does not yet have a production, accelerated GPU and frame baseline. Use baseline-derived budgets for the first measured change:

- React: unchanged completed narrative rows render zero times per targeted progress update. Median commit count and summed `actualDuration` must improve by at least 20% in the target fixture. No other fixture can regress by more than 10%.
- Frames: p95 frame interval, dropped-frame ratio, partial-frame ratio, long-task count, and maximum task duration must improve by at least 20% in the target fixture. No other fixture can regress by more than 10%. Express frame intervals against the measured display refresh, not a hard-coded 60 Hz assumption.
- Electron: per-process CPU p95 and working-set median must not regress by more than 10%. Idle CPU and memory limits remain baseline-derived until packaged-release samples exist.
- Windows GPU: per-process busiest-engine median and p95 must improve by at least 20% in the target fixture. No idle or panel fixture can regress by more than 10%. Do not create an absolute GPU percentage budget until five clean accelerated release samples exist on at least two supported GPU classes.

Replace these relative thresholds with absolute release budgets after the baseline exists. Keep development and release data separate. Issue 1240's development Electron medians, 1,103.4 MB process tree, and long tasks up to 3,216 ms are comparison evidence, not release certification.

## External skill assessment

The linked [`performance-engineer.md`](https://github.com/Emanuele-web04/skills/blob/main/skills/performance-engineer.md) supplies a sound checklist. Its best rule is to define one user-visible critical path, capture a baseline, attribute the cost, make the smallest change, and repeat the same measurement. Its cold-versus-warm split, multiple samples, median and p95, render-churn checklist, risk ranking, and behavior gates fit Mcode.

The skill is generic. It does not separate React commits, browser paint, compositor presentation, and Windows GPU engines. It does not cover Electron PID mapping, the shared GPU process, hidden or minimized windows, `backgroundThrottling`, DevTools overhead, trace loss, WDDM attribution, or the difference between GPU busy time and power.

Recommendation: do not install it as a Codex skill for this effort. Adapt its measured-critical-path rule and evidence template into [`docs/guides/performance-audit.md`](../guides/performance-audit.md), then add the Mcode-specific four-signal method from this report. The local guide already owns the relevant performance contract and can keep the Electron and Windows controls current.

## Wayfinder questions

1. Must Mcode remove the existing `disableHardwareAcceleration()` call, then set accelerated packaged release builds as the issue 1270 baseline?
2. Should the first implementation slice add measurement only, then choose between memoized narrative rows and TanStack RAF measurement from the trace result?
3. Should dense narrative stay one virtual item with memoized inner rows, or become a nested bounded viewport after behavior and accessibility research?
4. Which two Windows GPU classes and power mode form the release comparison pool?
5. Should the repository promote the issue 1240 fixture to `main`, or recreate it as a maintained issue 1270 runner with the output contract above?
