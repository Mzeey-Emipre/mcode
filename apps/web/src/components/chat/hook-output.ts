import type { HookExecution } from "@/transport/types";

/** Maximum hook output lines shown before expanding to the full buffer. */
export const HOOK_OUTPUT_LINE_CAP = 20;

/** Returns the bounded preview and full hook output lines for hook renderers. */
export function getHookOutputLines(hook: HookExecution): {
  previewLines: string[];
  fullLines: string[];
  hasOutput: boolean;
  hasMoreThanPreview: boolean;
} {
  const previewLines =
    hook.outputLines.length > 0
      ? hook.outputLines
      : hook.fullOutput.slice(0, HOOK_OUTPUT_LINE_CAP);
  const fullLines =
    hook.fullOutput.length > 0
      ? hook.fullOutput
      : hook.detailLines ?? hook.outputLines;
  return {
    previewLines,
    fullLines,
    hasOutput: previewLines.length > 0 || fullLines.length > 0,
    hasMoreThanPreview: fullLines.length > previewLines.length,
  };
}
