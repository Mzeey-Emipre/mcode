/** Bounded test-only control points for deterministic Browser conformance runs. */
export const BROWSER_CONFORMANCE_FAULT_CONTROL_KINDS = [
  "clock",
  "scheduling",
  "checkpoint",
  "host-transport",
  "executor-dispatch",
  "target-registration",
  "receipt-delivery",
  "capability-revision",
  "cleanup",
] as const;

/** One deterministic fault control selected for a bounded test run. */
export type BrowserConformanceFaultControlKind = (typeof BROWSER_CONFORMANCE_FAULT_CONTROL_KINDS)[number];

/** Configuration for one bounded occurrence of a deterministic control. */
export interface BrowserConformanceFaultControl {
  readonly kind: BrowserConformanceFaultControlKind;
  readonly occurrence?: number;
}

/** Error raised when a configured conformance control reaches its occurrence. */
export class BrowserConformanceInjectedFaultError extends Error {
  readonly kind: BrowserConformanceFaultControlKind;
  readonly occurrence: number;

  constructor(kind: BrowserConformanceFaultControlKind, occurrence: number) {
    super(`Browser conformance fault injected at ${kind} occurrence ${occurrence}`);
    this.name = "BrowserConformanceInjectedFaultError";
    this.kind = kind;
    this.occurrence = occurrence;
  }
}

/** Applies one bounded control and becomes inert after the scenario disposes. */
export class BrowserConformanceFaultController {
  private readonly calls = new Map<BrowserConformanceFaultControlKind, number>();
  private disposed = false;
  readonly control: BrowserConformanceFaultControl | undefined;

  constructor(control?: BrowserConformanceFaultControl) {
    if (control) {
      if (!isBrowserConformanceFaultControlKind(control.kind)) {
        throw new RangeError(`Unknown Browser conformance fault control kind: ${String(control.kind)}`);
      }
      const occurrence = control.occurrence ?? 1;
      if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > 256) {
        throw new RangeError("Browser conformance fault occurrence must be between 1 and 256");
      }
      this.control = { kind: control.kind, occurrence };
    }
  }

  /** Applies the configured fault if this control reaches its bounded occurrence. */
  hit(kind: BrowserConformanceFaultControlKind): void {
    if (this.disposed) return;
    const occurrence = (this.calls.get(kind) ?? 0) + 1;
    this.calls.set(kind, occurrence);
    if (this.control?.kind === kind && this.control.occurrence === occurrence) {
      throw new BrowserConformanceInjectedFaultError(kind, occurrence);
    }
  }

  /** Returns the bounded number of times one control has been reached. */
  callsFor(kind: BrowserConformanceFaultControlKind): number {
    return this.calls.get(kind) ?? 0;
  }

  /** Stops all future control effects and calls. Safe to invoke more than once. */
  dispose(): void {
    this.disposed = true;
  }

  /** Indicates whether this controller has been disposed by its scenario runner. */
  get isDisposed(): boolean {
    return this.disposed;
  }
}

function isBrowserConformanceFaultControlKind(value: unknown): value is BrowserConformanceFaultControlKind {
  return typeof value === "string"
    && (BROWSER_CONFORMANCE_FAULT_CONTROL_KINDS as readonly string[]).includes(value);
}
