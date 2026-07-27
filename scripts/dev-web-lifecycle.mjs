/** Resolves the dev:server parent process exit code after its server exits. */
export function resolveServerOnlyExitCode({ code, signal, cleanupRequested }) {
  if (Number.isInteger(code)) return code;
  if (cleanupRequested && (signal === "SIGINT" || signal === "SIGTERM")) return 0;
  return 1;
}
