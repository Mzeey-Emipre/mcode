import {
  AttachedBrowserCaptureSchema,
  clampAttachedBrowserCaptureForOutbound,
  type AttachedBrowserCapture,
} from "@mcode/contracts";

/** Opens the machine-readable fenced block appended to outbound user prompts. */
export const MCODE_BROWSER_CAPTURE_FENCE_OPEN = "<!-- mcode-browser-capture-v2 -->";

/** Closes the machine-readable fenced block appended to outbound user prompts. */
export const MCODE_BROWSER_CAPTURE_FENCE_CLOSE = "<!-- /mcode-browser-capture-v2 -->";

/**
 * Appends a stable HTML-comment fence describing preview screenshot metadata
 * (URL, bounds, v2 text outlines, console tail, optional failed request list)
 * keyed by attachment UUID. Omit when `captures` is empty.
 * Integrators outside this repo should parse `MCODE_BROWSER_CAPTURE_FENCE_OPEN`
 * and validate JSON with `AttachedBrowserCaptureSchema` from `@mcode/contracts` (v1 and v2 unions).
 */
export function appendBrowserCaptureFence(prompt: string, captures: AttachedBrowserCapture[]): string {
  if (captures.length === 0) return prompt;
  const validated = captures.map((c) =>
    AttachedBrowserCaptureSchema().parse(clampAttachedBrowserCaptureForOutbound(c)),
  );
  return `${prompt.trimEnd()}\n\n${MCODE_BROWSER_CAPTURE_FENCE_OPEN}\n${JSON.stringify(validated)}\n${MCODE_BROWSER_CAPTURE_FENCE_CLOSE}\n`;
}
