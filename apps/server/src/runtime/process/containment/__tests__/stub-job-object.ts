import type { JobObject } from "../job-object.js";

/**
 * Minimal `JobObject` for unit tests that construct providers without the DI container.
 * All methods are no-ops; `isWindowsJob` is false so platform-gated code paths are skipped.
 */
export function stubJobObject(): JobObject {
  return {
    isWindowsJob: false,
    assign: () => {},
    setDescription: () => {},
    close: () => {},
  } as unknown as JobObject;
}
