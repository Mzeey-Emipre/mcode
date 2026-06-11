/**
 * Returns true when the desktop process should print the app version and exit.
 */
export function shouldPrintVersion(argv: readonly string[]): boolean {
  return argv.includes("--version") || argv.includes("-v");
}
