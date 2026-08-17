/** Hard deadline for explicit shutdown before the desktop supervisor fallback. */
export const EXPLICIT_SHUTDOWN_DEADLINE_MS = 8_000;

/** Testable dependencies for explicit shutdown coordination. */
export interface ShutdownCoordinatorDependencies {
  shutdown: () => Promise<void>;
  deadlineMs?: number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
  exit?: (code: number) => never;
  onDeadline?: (phase: string) => void;
}

/** Coordinates one shutdown request and force-exits if a phase hangs. */
export interface ShutdownCoordinator {
  requestShutdown(): Promise<void> | undefined;
  setPhase(phase: string): void;
  getPhase(): string;
}

/** Creates a single-flight shutdown coordinator with a hard deadline watchdog. */
export function createShutdownCoordinator(
  dependencies: ShutdownCoordinatorDependencies,
): ShutdownCoordinator {
  const schedule = dependencies.schedule ?? setTimeout;
  const cancel = dependencies.cancel ?? clearTimeout;
  const deadlineMs = dependencies.deadlineMs ?? EXPLICIT_SHUTDOWN_DEADLINE_MS;
  const exit = dependencies.exit ?? ((code: number) => process.exit(code) as never);
  let phase = "not started";
  let shutdownPromise: Promise<void> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const clearWatchdog = () => {
    if (watchdog === null) return;
    cancel(watchdog);
    watchdog = null;
  };

  return {
    requestShutdown() {
      if (shutdownPromise) return shutdownPromise;
      watchdog = schedule(() => {
        dependencies.onDeadline?.(phase);
        exit(1);
      }, deadlineMs);
      shutdownPromise = dependencies.shutdown().finally(clearWatchdog);
      return shutdownPromise;
    },
    setPhase(nextPhase) {
      phase = nextPhase;
    },
    getPhase() {
      return phase;
    },
  };
}
