/** Minimal logger surface shared by the server recovery classes. */
export interface RecoveryLogger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Default recovery logger writing to the main-process console. */
export const consoleRecoveryLogger: RecoveryLogger = {
  log: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
};
