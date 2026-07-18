/** Hidden rollback switch that re-enables the retired raw browser-use pipe. */
export const LEGACY_BROWSER_USE_PIPE_ENV = "MCODE_ENABLE_LEGACY_BROWSER_USE_PIPE";

/** Returns whether this process explicitly requested the legacy raw browser-use bridge. */
export function shouldStartLegacyBrowserUseBridge(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[LEGACY_BROWSER_USE_PIPE_ENV] === "1";
}
