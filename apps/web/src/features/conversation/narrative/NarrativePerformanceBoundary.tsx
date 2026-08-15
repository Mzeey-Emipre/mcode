import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

interface ReactPerformanceSink {
  recordCommit(commit: {
    readonly actualDurationMs: number;
    readonly baseDurationMs: number;
    readonly phase: "mount" | "update" | "nested-update";
    readonly startTimeMs: number;
    readonly commitTimeMs: number;
  }): void;
  recordRowRender(rowId: string): void;
}

const profilingEnabled = import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "profiling";

declare global {
  interface Window {
    __mcodeReactPerformanceSink?: ReactPerformanceSink;
  }
}

const recordCommit: ProfilerOnRenderCallback = (
  _id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  window.__mcodeReactPerformanceSink?.recordCommit({
    actualDurationMs: actualDuration,
    baseDurationMs: baseDuration,
    phase,
    startTimeMs: startTime,
    commitTimeMs: commitTime,
  });
};

/** Records React commit data for the narrative surface in profiling builds. */
export function NarrativePerformanceBoundary({ children }: { readonly children: ReactNode }) {
  if (!profilingEnabled) return children;
  return (
    <Profiler id="narrative" onRender={recordCommit}>
      {children}
    </Profiler>
  );
}

/** Records one narrative row render without changing its DOM structure. */
export function NarrativePerformanceRow({
  children,
  rowId,
}: {
  readonly children: ReactNode;
  readonly rowId: string;
}) {
  if (profilingEnabled) window.__mcodeReactPerformanceSink?.recordRowRender(rowId);
  return <>{children}</>;
}

/** Returns a row identifier only when the React profiling build is active. */
export function narrativePerformanceRowId(rowId: string): string | undefined {
  return profilingEnabled ? rowId : undefined;
}
