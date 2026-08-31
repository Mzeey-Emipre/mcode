/** Resolves the explicit development opt-in for the web browser runtime. */
export function isBrowserAutomationWebRuntimeEnabled(
  env: Pick<ImportMetaEnv, "VITE_MCODE_WEB_AUTOMATION"> = import.meta.env,
): boolean {
  return env.VITE_MCODE_WEB_AUTOMATION === "1";
}

/** Observable preview states exposed by the pure web Browser surface. */
export type WebPreviewState = "disabled" | "unavailable" | "same-origin" | "cross-origin";

function isSafeWebPreviewUrl(parsed: URL): boolean {
  return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    !parsed.username && !parsed.password;
}

/** Classifies a preview URL without granting cross-origin DOM access. */
export function resolveWebPreviewState(
  url: string | null | undefined,
  enabled: boolean,
  origin: string = window.location.origin,
): WebPreviewState {
  if (!enabled) return "disabled";
  if (!url?.trim()) return "unavailable";
  try {
    const parsed = new URL(url);
    if (!isSafeWebPreviewUrl(parsed)) return "unavailable";
    return parsed.origin === origin ? "same-origin" : "cross-origin";
  } catch {
    return "unavailable";
  }
}

/** Accepts only bounded HTTP(S) URLs suitable for an iframe source. */
export function normalizeWebPreviewUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2_048) return null;
  try {
    const parsed = new URL(trimmed);
    if (!isSafeWebPreviewUrl(parsed)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}
