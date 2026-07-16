/** Maximum duration of one frame window used to detect repeated layout work. */
export const PULL_REQUEST_LAYOUT_FRAME_WINDOW_MS = 16.7;

/** Maximum number of layouts over 1 ms allowed during one bounded jump. */
export const PULL_REQUEST_SLOW_LAYOUT_MAX_COUNT = 2;

/** Result of applying the pull request layout-thrashing gate to a trace. */
export interface PullRequestLayoutGateResult {
  passed: boolean;
  slowLayoutCount: number;
  repeatedWithinFrame: boolean;
}

/** Apply the per-frame repetition and total-count limits to slow layout offsets. */
export function assessPullRequestLayoutOffsets(
  slowLayoutOffsetsMs: readonly number[],
): PullRequestLayoutGateResult {
  const orderedOffsets = [...slowLayoutOffsetsMs].sort((left, right) => left - right);
  const repeatedWithinFrame = orderedOffsets.some(
    (offset, index) =>
      index > 0 &&
      offset - (orderedOffsets[index - 1] ?? Number.NEGATIVE_INFINITY) <
        PULL_REQUEST_LAYOUT_FRAME_WINDOW_MS,
  );
  return {
    passed:
      !repeatedWithinFrame &&
      orderedOffsets.length <= PULL_REQUEST_SLOW_LAYOUT_MAX_COUNT,
    slowLayoutCount: orderedOffsets.length,
    repeatedWithinFrame,
  };
}
