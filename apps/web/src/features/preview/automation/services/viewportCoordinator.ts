import {
  BROWSER_AUTOMATION_MAX_VIEWPORT_PX,
  BROWSER_AUTOMATION_MIN_VIEWPORT_PX,
  resolveBrowserAutomationViewportPresentationScale,
  type BrowserAutomationViewportPresentation,
} from "@mcode/contracts";

/** Lower bound for a renderer CSS viewport dimension. */
export const MIN_VIEWPORT_CSS_PX = BROWSER_AUTOMATION_MIN_VIEWPORT_PX;

/** Upper bound for a renderer CSS viewport dimension. */
export const MAX_VIEWPORT_CSS_PX = BROWSER_AUTOMATION_MAX_VIEWPORT_PX;

/** Initial viewport used when a target has no confirmed user size yet. */
export const DEFAULT_VIEWPORT_SIZE = Object.freeze({ width: 1_280, height: 800 });

/** Maximum and minimum presentation scale used by Fit mode. */
export const MIN_VIEWPORT_PRESENTATION_SCALE = 0.2;
export const MAX_VIEWPORT_PRESENTATION_SCALE = 1.25;

/** Preset sizes shared by the responsive viewport toolbar. */
export const VIEWPORT_PRESETS = Object.freeze([
  Object.freeze({ id: "iphone-15-pro", label: "iPhone 15 Pro", width: 393, height: 852 }),
  Object.freeze({ id: "pixel-8", label: "Pixel 8", width: 412, height: 915 }),
  Object.freeze({ id: "ipad-air", label: "iPad Air", width: 820, height: 1_180 }),
  Object.freeze({ id: "surface-pro-7", label: "Surface Pro 7", width: 912, height: 1_368 }),
  Object.freeze({ id: "laptop", label: "Laptop", width: 1_280, height: 800 }),
  Object.freeze({ id: "desktop", label: "Desktop", width: 1_440, height: 900 }),
] as const);

/** One named responsive viewport preset. */
export type ViewportPreset = (typeof VIEWPORT_PRESETS)[number];

/** Browser viewport mode exposed by the toolbar. */
export type ViewportMode = "regular" | "responsive";

/** Browser viewport presentation mode exposed by the toolbar. */
export type ViewportPresentation = BrowserAutomationViewportPresentation;

/** Identifies whether an operation was initiated by an agent or a human. */
export type ViewportSource = "agent" | "user";

/** A CSS viewport size in renderer pixels. */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/** One viewport operation submitted to the Browser surface. */
export interface ViewportHostOperation {
  readonly operationId: string;
  readonly source: ViewportSource;
  readonly targetGeneration: number;
  readonly operationGeneration: number;
  readonly requested: ViewportSize;
}

/** One reset submitted to the Browser surface when Regular mode owns the target. */
export interface ViewportHostResetOperation {
  readonly operationId: string;
  readonly source: ViewportSource;
  readonly targetGeneration: number;
  readonly operationGeneration: number;
  readonly requested: ViewportSize;
}

/** Host outcome returned after it has applied, rejected, or superseded an operation. */
export interface ViewportHostResult {
  readonly status: "applied" | "stale" | "failed";
  readonly applied: ViewportSize;
  readonly error?: string;
}

/** Host outcome returned after it removes an explicit responsive viewport. */
export interface ViewportHostResetResult {
  readonly status: "applied" | "stale" | "failed";
  readonly applied: ViewportSize | null;
  readonly error?: string;
}

/** One presentation change applied to the Browser surface. */
export interface ViewportPresentationHostOperation {
  readonly operationId: string;
  readonly source: ViewportSource;
  readonly targetGeneration: number;
  readonly operationGeneration: number;
  readonly requested: ViewportSize;
  readonly presentation: ViewportPresentation;
}

/** Host outcome returned after a presentation change is applied or rejected. */
export interface ViewportPresentationHostResult {
  readonly status: "applied" | "stale" | "failed";
  readonly applied: ViewportPresentation;
  readonly appliedViewport: ViewportSize | null;
  readonly error?: string;
}

/** Result returned to a caller after the coordinator reconciles host state. */
export interface ViewportApplyResult {
  readonly operationId: string;
  readonly source: ViewportSource;
  readonly targetGeneration: number;
  readonly operationGeneration: number;
  readonly requested: ViewportSize;
  readonly applied: ViewportSize;
  readonly status: "applied" | "clamped" | "stale" | "failed" | "superseded";
  readonly error?: string;
}

/** Result returned to a caller after a presentation host acknowledgement. */
export interface ViewportPresentationApplyResult {
  readonly operationId: string;
  readonly source: ViewportSource;
  readonly targetGeneration: number;
  readonly operationGeneration: number;
  readonly requested: ViewportPresentation;
  readonly applied: ViewportPresentation;
  readonly appliedViewport: ViewportSize | null;
  readonly status: "applied" | "stale" | "failed" | "superseded";
  readonly error?: string;
}

/** Snapshot of the state a viewport host should render. */
export interface ViewportCoordinatorState {
  readonly mode: ViewportMode;
  readonly presentation: ViewportPresentation;
  readonly confirmed: ViewportSize;
  readonly userConfirmed: ViewportSize;
  readonly targetGeneration: number;
  readonly pending: ViewportHostOperation | null;
  readonly pendingReset: ViewportHostResetOperation | null;
  readonly pendingPresentation: ViewportPresentationHostOperation | null;
  readonly presentationError: string | null;
  readonly agentActive: boolean;
}

/** Optional identity supplied by a transport request or UI interaction. */
export interface ViewportOperationIdentity {
  readonly operationId?: string;
  readonly targetGeneration?: number;
}

/** Context needed to calculate Fit scale for a viewport canvas. */
export interface ViewportCanvasBounds {
  readonly width: number;
  readonly height: number;
}

/** Host contract used by one coordinator instance. */
export interface ViewportHost {
  apply(operation: ViewportHostOperation): Promise<ViewportHostResult>;
  reset?(operation: ViewportHostResetOperation): Promise<ViewportHostResetResult>;
  applyPresentation?(
    operation: ViewportPresentationHostOperation,
  ): Promise<ViewportPresentationHostResult>;
}

/** Options for creating a viewport coordinator. */
export interface ViewportCoordinatorOptions {
  readonly apply: ViewportHost["apply"];
  readonly reset?: NonNullable<ViewportHost["reset"]>;
  readonly initial?: ViewportSize;
  readonly targetGeneration?: number;
  readonly mode?: ViewportMode;
  readonly presentation?: ViewportPresentation;
  readonly operationId?: (operation: Omit<ViewportHostOperation, "operationId">, sequence: number) => string;
  readonly applyPresentation?: NonNullable<ViewportHost["applyPresentation"]>;
  readonly onStateChange?: (state: ViewportCoordinatorState) => void;
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return MIN_VIEWPORT_CSS_PX;
  return Math.min(MAX_VIEWPORT_CSS_PX, Math.max(MIN_VIEWPORT_CSS_PX, Math.round(value)));
}

/** Clamp both viewport dimensions to the renderer CSS viewport contract. */
export function clampViewportSize(size: ViewportSize): ViewportSize {
  return { width: clampDimension(size.width), height: clampDimension(size.height) };
}

function sameSize(left: ViewportSize, right: ViewportSize): boolean {
  return left.width === right.width && left.height === right.height;
}

function scaleWithinBounds(value: number): number {
  return Math.min(MAX_VIEWPORT_PRESENTATION_SCALE, Math.max(MIN_VIEWPORT_PRESENTATION_SCALE, value));
}

/** Calculate Fit, Actual, or fixed zoom scale without mutating coordinator state. */
export function calculateViewportPresentationScale(
  size: ViewportSize,
  bounds: ViewportCanvasBounds,
  presentation: ViewportPresentation,
): number {
  const fixedScale = resolveBrowserAutomationViewportPresentationScale(presentation);
  if (fixedScale !== null) return fixedScale;
  const width = Number.isFinite(bounds.width) ? bounds.width : 0;
  const height = Number.isFinite(bounds.height) ? bounds.height : 0;
  if (width <= 0 || height <= 0 || size.width <= 0 || size.height <= 0) {
    return MIN_VIEWPORT_PRESENTATION_SCALE;
  }
  return scaleWithinBounds(Math.min(width / size.width, height / size.height));
}

interface PendingOperation {
  readonly operation: ViewportHostOperation;
  readonly source: ViewportSource;
  readonly requested: ViewportSize;
  readonly inputWasClamped: boolean;
  resolve: (result: ViewportApplyResult) => void;
  settled: boolean;
}

interface PendingResetOperation {
  readonly operation: ViewportHostResetOperation;
  resolve: (result: ViewportApplyResult) => void;
  settled: boolean;
}

interface PendingPresentationOperation {
  readonly operation: ViewportPresentationHostOperation;
  resolve: (result: ViewportPresentationApplyResult) => void;
  settled: boolean;
}

/**
 * Coordinates user and agent viewport changes while retaining only host-confirmed dimensions.
 *
 * A coordinator is intentionally scoped to one exact Browser tab. The caller owns target
 * discovery and supplies the current target generation before submitting an operation.
 */
export class ViewportCoordinator {
  private readonly applyHost: ViewportHost["apply"];
  private readonly resetHost: ViewportCoordinatorOptions["reset"];
  private readonly applyPresentationHost: ViewportCoordinatorOptions["applyPresentation"];
  private readonly operationIdFactory: NonNullable<ViewportCoordinatorOptions["operationId"]>;
  private confirmed: ViewportSize;
  private userConfirmed: ViewportSize;
  private mode: ViewportMode;
  private userMode: ViewportMode;
  private presentation: ViewportPresentation;
  private targetGeneration: number;
  private pending: PendingOperation | null = null;
  private pendingReset: PendingResetOperation | null = null;
  private pendingPresentation: PendingPresentationOperation | null = null;
  private presentationError: string | null = null;
  private superseded: PendingOperation[] = [];
  private supersededResets: PendingResetOperation[] = [];
  private sequence = 0;
  private agentActive = false;
  private interrupted = false;
  private readonly stateListeners = new Set<(state: ViewportCoordinatorState) => void>();

  /** Create a coordinator for one target with a confirmed initial viewport. */
  public constructor(options: ViewportCoordinatorOptions) {
    const initial = clampViewportSize(options.initial ?? DEFAULT_VIEWPORT_SIZE);
    this.applyHost = options.apply;
    this.resetHost = options.reset;
    this.applyPresentationHost = options.applyPresentation;
    this.operationIdFactory = options.operationId ?? ((operation, sequence) =>
      `${operation.source}:${operation.targetGeneration}:${sequence}`);
    this.confirmed = initial;
    this.userConfirmed = initial;
    this.mode = options.mode ?? "regular";
    this.userMode = this.mode;
    this.presentation = options.presentation ?? "fit";
    this.targetGeneration = Math.max(0, Math.trunc(options.targetGeneration ?? 0));
    if (options.onStateChange) this.stateListeners.add(options.onStateChange);
  }

  /** Subscribe to confirmed, presentation, and pending state transitions. */
  public subscribe(listener: (state: ViewportCoordinatorState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Return a stable snapshot of confirmed and pending state. */
  public snapshot(): ViewportCoordinatorState {
    return {
      mode: this.mode,
      presentation: this.presentation,
      confirmed: { ...this.confirmed },
      userConfirmed: { ...this.userConfirmed },
      targetGeneration: this.targetGeneration,
      pending: this.pending ? { ...this.pending.operation, requested: { ...this.pending.requested } } : null,
      pendingReset: this.pendingReset ? { ...this.pendingReset.operation, requested: { ...this.pendingReset.operation.requested } } : null,
      pendingPresentation: this.pendingPresentation
        ? { ...this.pendingPresentation.operation, requested: { ...this.pendingPresentation.operation.requested } }
        : null,
      presentationError: this.presentationError,
      agentActive: this.agentActive,
    };
  }

  /** Change Regular or Responsive mode without changing the CSS viewport dimensions. */
  public setMode(mode: ViewportMode): ViewportCoordinatorState {
    this.mode = mode;
    if (!this.agentActive) this.userMode = mode;
    return this.notify();
  }

  /** Select a user-owned mode while preserving any active agent control. */
  public setUserMode(mode: ViewportMode): ViewportCoordinatorState {
    this.userMode = mode;
    if (!this.agentActive) this.mode = mode;
    return this.notify();
  }

  /** Select a user-owned mode and reconcile the active host with that choice. */
  public requestUserMode(mode: ViewportMode): Promise<ViewportApplyResult | null> {
    if (mode === "responsive" && this.mode === "responsive") return Promise.resolve(null);
    this.userMode = mode;
    if (mode === "responsive") {
      this.mode = mode;
      this.notify();
      return this.requestResize("user", this.userConfirmed, {});
    }
    this.notify();
    return this.requestReset("user", {});
  }

  /** Change Fit or Actual presentation after the active host confirms the request. */
  public setPresentation(presentation: ViewportPresentation): Promise<ViewportPresentationApplyResult> {
    const sequence = ++this.sequence;
    const descriptor = {
      source: "user" as const,
      targetGeneration: this.targetGeneration,
      operationGeneration: sequence,
      requested: { ...this.confirmed },
    };
    const operation: ViewportPresentationHostOperation = {
      ...descriptor,
      presentation,
      operationId: this.operationIdFactory(descriptor, sequence),
    };
    this.settlePendingPresentation("superseded");
    this.interrupted = false;

    if (presentation === this.presentation && !this.applyPresentationHost) {
      this.presentationError = null;
      this.notify();
      return Promise.resolve(this.presentationResult(operation, presentation, { ...this.confirmed }, "applied"));
    }

    if (!this.applyPresentationHost) {
      this.presentation = presentation;
      this.presentationError = null;
      this.notify();
      return Promise.resolve(this.presentationResult(operation, presentation, { ...this.confirmed }, "applied"));
    }

    return new Promise<ViewportPresentationApplyResult>((resolve) => {
      const pending: PendingPresentationOperation = { operation, resolve, settled: false };
      this.pendingPresentation = pending;
      this.presentationError = null;
      this.notify();
      void this.applyPresentation(pending);
    });
  }

  /** Return the visual scale for a viewport canvas, leaving Actual mode at one-to-one. */
  public getPresentationScale(bounds: ViewportCanvasBounds): number {
    return calculateViewportPresentationScale(this.confirmed, bounds, this.presentation);
  }

  /** Notify the coordinator that the exact target has been remounted at a new generation. */
  public setTargetGeneration(targetGeneration: number): void {
    const nextGeneration = Math.max(0, Math.trunc(targetGeneration));
    if (nextGeneration === this.targetGeneration) return;
    this.targetGeneration = nextGeneration;
    this.interrupted = true;
    this.settlePending("stale");
    this.settlePendingReset("stale");
    this.settlePendingPresentation("stale");
    this.flushSuperseded("stale");
    this.agentActive = false;
    this.notify();
  }

  /** Submit a user viewport change. Only an applied host acknowledgement becomes confirmed state. */
  public requestUserResize(
    size: ViewportSize,
    identity: ViewportOperationIdentity = {},
  ): Promise<ViewportApplyResult> {
    this.userMode = this.mode;
    return this.requestResize("user", size, identity);
  }

  /** Submit an agent viewport change for the current target generation. */
  public requestAgentResize(
    size: ViewportSize,
    identity: ViewportOperationIdentity = {},
  ): Promise<ViewportApplyResult> {
    this.agentActive = true;
    this.mode = "responsive";
    this.notify();
    return this.requestResize("agent", size, identity);
  }

  /** Rotate the last confirmed user viewport and submit it as a user operation. */
  public rotate(): Promise<ViewportApplyResult> {
    return this.requestUserResize({
      width: this.userConfirmed.height,
      height: this.userConfirmed.width,
    });
  }

  /** Restore the latest confirmed user viewport after a normal agent completion. */
  public completeAgent(identity: ViewportOperationIdentity = {}): Promise<ViewportApplyResult | null> {
    if (!this.agentActive) return Promise.resolve(null);
    this.agentActive = false;
    if (this.userMode === "regular") {
      this.notify();
      return this.requestReset("user", identity);
    }
    this.mode = "responsive";
    this.notify();
    if (sameSize(this.confirmed, this.userConfirmed)) return Promise.resolve(null);
    return this.requestResize("user", this.userConfirmed, identity);
  }

  /** Invalidate pending operations while preserving the last host-confirmed state. */
  public interrupt(): void {
    const reconcileHost = this.agentActive || this.pending?.source === "agent" ||
      this.pendingReset?.operation.source === "agent" ||
      this.pendingPresentation?.operation.source === "agent";
    const confirmedBeforeInterruption = { ...this.confirmed };
    this.interrupted = true;
    this.agentActive = false;
    this.settlePending("stale");
    this.settlePendingReset("stale");
    this.settlePendingPresentation("stale");
    this.flushSuperseded("stale");
    this.notify();
    if (reconcileHost) void this.requestResize("user", confirmedBeforeInterruption, {});
  }

  private requestResize(
    source: ViewportSource,
    input: ViewportSize,
    identity: ViewportOperationIdentity,
  ): Promise<ViewportApplyResult> {
    this.interrupted = false;
    const requested = clampViewportSize(input);
    const sequence = ++this.sequence;
    const targetGeneration = identity.targetGeneration === undefined
      ? this.targetGeneration
      : Math.max(0, Math.trunc(identity.targetGeneration));
    const descriptor = { source, targetGeneration, operationGeneration: sequence, requested };
    const operation: ViewportHostOperation = {
      ...descriptor,
      operationId: identity.operationId ?? this.operationIdFactory(descriptor, sequence),
    };

    this.settlePending("superseded");
    this.settlePendingReset("superseded");
    return new Promise<ViewportApplyResult>((resolve) => {
      const pending: PendingOperation = {
        operation,
        source,
        requested,
        inputWasClamped: !sameSize(input, requested),
        resolve,
        settled: false,
      };
      this.pending = pending;
      this.notify();
      void this.apply(pending);
    });
  }

  private requestReset(
    source: ViewportSource,
    identity: ViewportOperationIdentity,
  ): Promise<ViewportApplyResult> {
    this.interrupted = false;
    const sequence = ++this.sequence;
    const targetGeneration = identity.targetGeneration === undefined
      ? this.targetGeneration
      : Math.max(0, Math.trunc(identity.targetGeneration));
    const requested = { ...this.userConfirmed };
    const descriptor = { source, targetGeneration, operationGeneration: sequence, requested };
    const operation: ViewportHostResetOperation = {
      ...descriptor,
      operationId: identity.operationId ?? this.operationIdFactory(descriptor, sequence),
    };

    this.settlePending("superseded");
    this.settlePendingReset("superseded");
    return new Promise<ViewportApplyResult>((resolve) => {
      const pending: PendingResetOperation = { operation, resolve, settled: false };
      this.pendingReset = pending;
      this.notify();
      if (!this.resetHost) {
        this.pendingReset = null;
        this.notify();
        this.resolveReset(pending, {
          operationId: operation.operationId,
          source,
          targetGeneration,
          operationGeneration: operation.operationGeneration,
          requested,
          applied: { ...this.confirmed },
          status: "failed",
          error: "Viewport reset host is unavailable",
        });
        this.flushSuperseded("superseded");
        return;
      }
      void this.applyReset(pending);
    });
  }

  private async apply(pending: PendingOperation): Promise<void> {
    let hostResult: ViewportHostResult;
    try {
      hostResult = await this.applyHost(pending.operation);
    } catch (cause) {
      hostResult = {
        status: "failed",
        applied: this.confirmed,
        error: cause instanceof Error ? cause.message : "Viewport host failed",
      };
    }

    const current = this.pending === pending && !pending.settled;
    if (!current || this.interrupted || pending.operation.targetGeneration !== this.targetGeneration) {
      if (!pending.settled && this.superseded.includes(pending)) return;
      this.resolvePending(pending, {
        operationId: pending.operation.operationId,
        source: pending.source,
        targetGeneration: pending.operation.targetGeneration,
        operationGeneration: pending.operation.operationGeneration,
        requested: pending.requested,
        applied: { ...this.confirmed },
        status: this.interrupted ? "stale" : "superseded",
      });
      return;
    }

    const applied = clampViewportSize(hostResult.applied);
    if (hostResult.status === "stale") {
      this.resolvePending(pending, {
        operationId: pending.operation.operationId,
        source: pending.source,
        targetGeneration: pending.operation.targetGeneration,
        operationGeneration: pending.operation.operationGeneration,
        requested: pending.requested,
        applied: { ...applied },
        status: "stale",
        error: hostResult.error,
      });
      this.pending = null;
      this.flushSuperseded("stale");
      this.notify();
      return;
    }
    if (hostResult.status === "failed") {
      this.resolvePending(pending, {
        operationId: pending.operation.operationId,
        source: pending.source,
        targetGeneration: pending.operation.targetGeneration,
        operationGeneration: pending.operation.operationGeneration,
        requested: pending.requested,
        applied: { ...applied },
        status: "failed",
        error: hostResult.error,
      });
      this.pending = null;
      this.flushSuperseded("superseded");
      this.notify();
      return;
    }

    this.confirmed = applied;
    if (pending.source === "user") this.userConfirmed = applied;
    this.pending = null;
    this.notify();
    this.resolvePending(pending, {
      operationId: pending.operation.operationId,
      source: pending.source,
      targetGeneration: pending.operation.targetGeneration,
      operationGeneration: pending.operation.operationGeneration,
      requested: pending.requested,
      applied,
      status: !sameSize(applied, pending.requested) || pending.inputWasClamped ? "clamped" : "applied",
      error: hostResult.error,
    });
    this.flushSuperseded("superseded");
  }

  private async applyReset(pending: PendingResetOperation): Promise<void> {
    let hostResult: ViewportHostResetResult;
    try {
      hostResult = await this.resetHost!(pending.operation);
    } catch (cause) {
      hostResult = {
        status: "failed",
        applied: null,
        error: cause instanceof Error ? cause.message : "Viewport reset host failed",
      };
    }

    const current = this.pendingReset === pending && !pending.settled;
    if (!current || this.interrupted || pending.operation.targetGeneration !== this.targetGeneration) {
      if (pending.settled) return;
      this.resolveReset(pending, {
        operationId: pending.operation.operationId,
        source: pending.operation.source,
        targetGeneration: pending.operation.targetGeneration,
        operationGeneration: pending.operation.operationGeneration,
        requested: pending.operation.requested,
        applied: { ...this.confirmed },
        status: this.interrupted ? "stale" : "superseded",
      });
      return;
    }

    this.pendingReset = null;
    if (hostResult.status === "stale" || hostResult.status === "failed") {
      this.resolveReset(pending, {
        operationId: pending.operation.operationId,
        source: pending.operation.source,
        targetGeneration: pending.operation.targetGeneration,
        operationGeneration: pending.operation.operationGeneration,
        requested: pending.operation.requested,
        applied: hostResult.applied ?? { ...this.confirmed },
        status: hostResult.status,
        error: hostResult.error,
      });
      this.notify();
      this.flushSuperseded(hostResult.status === "stale" ? "stale" : "superseded");
      return;
    }

    this.mode = "regular";
    this.resolveReset(pending, {
      operationId: pending.operation.operationId,
      source: pending.operation.source,
      targetGeneration: pending.operation.targetGeneration,
      operationGeneration: pending.operation.operationGeneration,
      requested: pending.operation.requested,
      applied: hostResult.applied ?? { ...this.confirmed },
      status: "applied",
      error: hostResult.error,
    });
    this.notify();
    this.flushSuperseded("superseded");
  }

  private async applyPresentation(pending: PendingPresentationOperation): Promise<void> {
    let hostResult: ViewportPresentationHostResult;
    try {
      hostResult = await this.applyPresentationHost!(pending.operation);
    } catch (cause) {
      hostResult = {
        status: "failed",
        applied: this.presentation,
        appliedViewport: { ...this.confirmed },
        error: cause instanceof Error ? cause.message : "Viewport presentation host failed",
      };
    }

    const current = this.pendingPresentation === pending && !pending.settled;
    if (!current || this.interrupted || pending.operation.targetGeneration !== this.targetGeneration) {
      if (pending.settled) return;
      this.resolvePresentation(pending, this.presentationResult(
        pending.operation,
        this.presentation,
        hostResult.appliedViewport ?? { ...this.confirmed },
        this.interrupted ? "stale" : "superseded",
        hostResult.error,
      ));
      return;
    }

    this.pendingPresentation = null;
    if (hostResult.status === "applied" && hostResult.applied === pending.operation.presentation) {
      this.presentation = hostResult.applied;
      this.presentationError = null;
      this.notify();
      this.resolvePresentation(pending, this.presentationResult(
        pending.operation,
        hostResult.applied,
        hostResult.appliedViewport,
        "applied",
      ));
      return;
    }

    const status = hostResult.status === "stale" ||
      (hostResult.status === "applied" && hostResult.applied !== pending.operation.presentation)
      ? "stale"
      : "failed";
    const error = hostResult.error ?? (
      status === "stale"
        ? "Viewport presentation host acknowledgement is stale"
        : "Viewport presentation host failed"
    );
    this.presentationError = error;
    this.notify();
    this.resolvePresentation(pending, this.presentationResult(
      pending.operation,
      this.presentation,
      hostResult.appliedViewport ?? { ...this.confirmed },
      status,
      error,
    ));
  }

  private settlePending(status: "stale" | "superseded"): void {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    this.pending = null;
    if (status === "superseded") {
      this.superseded.push(pending);
      this.notify();
      return;
    }
    this.resolvePending(pending, {
      operationId: pending.operation.operationId,
      source: pending.source,
      targetGeneration: pending.operation.targetGeneration,
      operationGeneration: pending.operation.operationGeneration,
      requested: pending.requested,
      applied: { ...this.confirmed },
      status,
    });
    this.notify();
  }

  private settlePendingReset(status: "stale" | "superseded"): void {
    const pending = this.pendingReset;
    if (!pending || pending.settled) return;
    this.pendingReset = null;
    if (status === "superseded") {
      this.supersededResets.push(pending);
      this.notify();
      return;
    }
    this.resolveReset(pending, {
      operationId: pending.operation.operationId,
      source: pending.operation.source,
      targetGeneration: pending.operation.targetGeneration,
      operationGeneration: pending.operation.operationGeneration,
      requested: pending.operation.requested,
      applied: { ...this.confirmed },
      status,
    });
    this.notify();
  }

  private settlePendingPresentation(status: "stale" | "superseded"): void {
    const pending = this.pendingPresentation;
    if (!pending || pending.settled) return;
    this.pendingPresentation = null;
    this.resolvePresentation(pending, this.presentationResult(
      pending.operation,
      this.presentation,
      { ...this.confirmed },
      status,
    ));
    this.notify();
  }

  private flushSuperseded(status: "stale" | "superseded"): void {
    if (this.superseded.length === 0 && this.supersededResets.length === 0) return;
    const pending = this.superseded.splice(0);
    for (const item of pending) {
      this.resolvePending(item, {
        operationId: item.operation.operationId,
        source: item.source,
        targetGeneration: item.operation.targetGeneration,
        operationGeneration: item.operation.operationGeneration,
        requested: item.requested,
        applied: { ...this.confirmed },
        status,
      });
    }
    const resets = this.supersededResets.splice(0);
    for (const item of resets) {
      this.resolveReset(item, {
        operationId: item.operation.operationId,
        source: item.operation.source,
        targetGeneration: item.operation.targetGeneration,
        operationGeneration: item.operation.operationGeneration,
        requested: item.operation.requested,
        applied: { ...this.confirmed },
        status,
      });
    }
  }

  private resolvePending(pending: PendingOperation, result: ViewportApplyResult): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.resolve(result);
  }

  private resolveReset(pending: PendingResetOperation, result: ViewportApplyResult): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.resolve(result);
  }

  private resolvePresentation(
    pending: PendingPresentationOperation,
    result: ViewportPresentationApplyResult,
  ): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.resolve(result);
  }

  private presentationResult(
    operation: ViewportPresentationHostOperation,
    applied: ViewportPresentation,
    appliedViewport: ViewportSize | null,
    status: ViewportPresentationApplyResult["status"],
    error?: string,
  ): ViewportPresentationApplyResult {
    return {
      operationId: operation.operationId,
      source: operation.source,
      targetGeneration: operation.targetGeneration,
      operationGeneration: operation.operationGeneration,
      requested: operation.presentation,
      applied,
      appliedViewport,
      status,
      ...(error === undefined ? {} : { error }),
    };
  }

  private notify(): ViewportCoordinatorState {
    const snapshot = this.snapshot();
    for (const listener of this.stateListeners) listener(snapshot);
    return snapshot;
  }
}
