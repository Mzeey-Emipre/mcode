/** Options controlling a bounded deferred task. */
export interface DeferredWorkOptions {
  /** Delay before running the task. Defaults to the next available frame. */
  delayMs?: number;
  /** Maximum delay before the task runs even when frames are unavailable. */
  maxDelayMs?: number;
}

/** Handle returned by {@link scheduleDeferredWork}. */
export interface DeferredWorkHandle {
  /** Cancel the task when the owning selection is superseded. */
  cancel(): void;
  /** Whether cancellation has already been requested. */
  readonly cancelled: boolean;
}

/** Schedule non-critical hydration work with a bounded, cancellable delay. */
export function scheduleDeferredWork(
  work: () => void,
  options: DeferredWorkOptions = {},
): DeferredWorkHandle {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  const run = () => {
    if (cancelled) return;
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (frame !== undefined && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(frame);
    }
    if (deadline !== undefined) clearTimeout(deadline);
    work();
  };
  const delayMs = Math.max(0, options.delayMs ?? 0);
  const maxDelayMs = Math.max(delayMs, options.maxDelayMs ?? 100);
  const raf = typeof globalThis.requestAnimationFrame === "function"
    ? globalThis.requestAnimationFrame
    : undefined;
  if (delayMs === 0 && raf) frame = raf(run);
  else timer = setTimeout(run, delayMs);
  const deadline: ReturnType<typeof setTimeout> = setTimeout(run, maxDelayMs);
  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (frame !== undefined && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(frame);
      }
      clearTimeout(deadline);
    },
    get cancelled() {
      return cancelled;
    },
  };
}
