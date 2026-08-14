/** Private renderer argument used to opt into packaged terminal release tests. */
export const TERMINAL_RELEASE_TEST_ARGUMENT = "--mcode-terminal-release-test";

/** Return whether the packaged terminal release-test capability should be enabled. */
export function isTerminalReleaseTestEnabled(
  isPackaged: boolean,
  environmentValue: string | undefined,
): boolean {
  return isPackaged && environmentValue === "1";
}

/** Build the private renderer arguments for the terminal release-test capability. */
export function buildTerminalReleaseTestRendererArguments(
  enabled: boolean,
): string[] {
  return enabled ? [TERMINAL_RELEASE_TEST_ARGUMENT] : [];
}

/** Return whether the renderer received the exact terminal release-test argument. */
export function hasTerminalReleaseTestArgument(
  argv: readonly string[],
): boolean {
  return argv.some((argument) => argument === TERMINAL_RELEASE_TEST_ARGUMENT);
}
