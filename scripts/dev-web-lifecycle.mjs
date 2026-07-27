/** Resolves the dev:server parent process exit code after its server exits. */
export function resolveServerOnlyExitCode({ code, signal, cleanupRequested }) {
  if (cleanupRequested) return 0;
  if (Number.isInteger(code)) return code;
  if (signal) return 1;
  return 1;
}
