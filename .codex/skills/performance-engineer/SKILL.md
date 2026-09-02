---
name: performance-engineer
description: Measure, diagnose, and safely improve Mcode performance across startup, frontend rendering, rerenders, frame stability, CPU, memory, GPU, IPC, bundle size, and data paths. Use before a benchmark, profiler investigation, or implementation justified by speed, responsiveness, resource use, or scalability.
---

# Performance Engineer

Optimize a measured critical path. Preserve behavior while you attribute the cost, make the smallest useful change, and verify the result with the same measurement.

This skill adapts the workflow from [Emanuele-web04/skills](https://github.com/Emanuele-web04/skills/blob/main/skills/performance-engineer.md) for Mcode.

## Workflow

1. Read [`docs/guides/performance-audit.md`](../../../docs/guides/performance-audit.md). It owns Mcode's budgets, evidence rules, and runtime-specific controls.
2. Name the exact user-visible or system-visible path. Define its environment, input, metric, and behavior invariants.
3. Write one hypothesis: `<cost> is caused by <specific work> because <evidence>`.
4. Capture a repeatable baseline before you edit. Separate cold from warm, development from release, and small from realistic input. Use multiple samples for noisy timings.
5. Attribute the cost. Classify it as early work, repeated work, excess work, serial work, wrong data shape, N+1 work, render churn, layout churn, or an unsafe cache boundary.
6. Make the smallest change that removes the measured cost. Keep public behavior, ordering, permissions, pagination, accessibility, and error behavior stable.
7. Repeat the same measurement under the same conditions. Run focused behavior tests and live verification.

## Frontend and Electron rule

Keep these signals separate:

- React Profiler data measures React commits and render duration.
- Chromium traces measure scripting, layout, paint, long tasks, and frame delivery.
- Electron `app.getAppMetrics()` measures process CPU and memory.
- OS counters or traces measure GPU-engine use. Render counts and Electron GPU information do not measure GPU utilization.

Record the hardware-acceleration state and keep it fixed within a comparison. Use a profiling build for React evidence and a normal production build without open DevTools for process and GPU evidence.

## Completion evidence

Report:

- the target, environment, baseline, sample count, and statistic;
- the attributed cause and the files or trace events that support it;
- the smallest change and the behavior that stayed stable;
- before and after results from the same measurement;
- focused tests, live evidence, the regression gate, and residual uncertainty.

Do not claim a performance gain from a single sample, a scanner result, a microbenchmark outside the hot path, or a different environment.
