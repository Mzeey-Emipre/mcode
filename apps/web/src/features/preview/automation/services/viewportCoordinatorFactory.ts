import {
  DEFAULT_VIEWPORT_SIZE,
  ViewportCoordinator,
  type ViewportCoordinatorOptions,
  type ViewportHostOperation,
  type ViewportHostResult,
  type ViewportHostResetOperation,
  type ViewportHostResetResult,
  type ViewportPresentation,
  type ViewportMode,
  type ViewportSize,
} from "./viewportCoordinator";

/** Exact Browser target that owns one viewport coordinator. */
export interface ViewportCoordinatorTarget {
  readonly threadId: string;
  readonly tabId: string;
}

/** Browser surface operations required by viewport coordination. */
export interface ViewportSurfaceAdapter {
  readonly setViewport: (
    size: ViewportSize,
    operation: ViewportHostOperation,
    coordinator: ViewportCoordinator,
  ) => boolean;
  readonly readViewport: () => ViewportSize | null;
  readonly resetViewport?: (
    operation: ViewportHostResetOperation,
    coordinator: ViewportCoordinator,
  ) => boolean;
  readonly waitForLayout?: () => Promise<void>;
  readonly isCurrent?: (operation: ViewportHostOperation, coordinator: ViewportCoordinator) => boolean;
}

/** Inputs shared by every Browser surface viewport coordinator creation path. */
export interface ViewportCoordinatorFactoryOptions {
  readonly target: ViewportCoordinatorTarget;
  readonly targetGeneration: number;
  readonly initial?: ViewportSize;
  readonly mode?: ViewportMode;
  readonly presentation?: ViewportPresentation;
  readonly surface?: ViewportSurfaceAdapter;
  readonly readConfirmed?: () => ViewportSize | null;
  readonly operationId?: ViewportCoordinatorOptions["operationId"];
  readonly onStateChange?: (
    state: Parameters<NonNullable<ViewportCoordinatorOptions["onStateChange"]>>[0],
    coordinator: ViewportCoordinator,
  ) => void;
}

/** Options for reusing a per-tab coordinator or creating it once. */
export interface GetOrCreateViewportCoordinatorOptions extends ViewportCoordinatorFactoryOptions {
  readonly existing?: ViewportCoordinator;
  readonly onCreated?: (coordinator: ViewportCoordinator) => void;
}

/** Wait for a bounded number of browser layout frames without outliving a viewport request. */
export async function waitForViewportLayout(frameCount = 1, timeoutMs = 250): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let observedFrames = 0;
    let frameId: number | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutId);
      if (frameId !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameId);
      resolve();
    };
    const onFrame = (): void => {
      observedFrames += 1;
      if (observedFrames >= frameCount) {
        finish();
        return;
      }
      frameId = requestAnimationFrame(onFrame);
    };
    const timeoutId = globalThis.setTimeout(finish, timeoutMs);
    frameId = requestAnimationFrame(onFrame);
  });
}

function fallbackViewport(options: ViewportCoordinatorFactoryOptions): ViewportSize {
  return options.readConfirmed?.() ?? options.initial ?? DEFAULT_VIEWPORT_SIZE;
}

function surfaceViewportAdapter(
  options: ViewportCoordinatorFactoryOptions,
  coordinator: ViewportCoordinator,
): (operation: ViewportHostOperation) => Promise<ViewportHostResult> {
  return async (operation) => {
    const surface = options.surface;
    if (!surface) {
      return {
        status: "failed",
        applied: fallbackViewport(options),
        error: "Browser viewport target is unavailable",
      };
    }
    if (!surface.setViewport(operation.requested, operation, coordinator)) {
      return {
        status: "stale",
        applied: fallbackViewport(options),
        error: "Browser viewport target is no longer current",
      };
    }
    await surface.waitForLayout?.();
    if (surface.isCurrent && !surface.isCurrent(operation, coordinator)) {
      return {
        status: "stale",
        applied: fallbackViewport(options),
        error: "Browser viewport target is no longer current",
      };
    }
    const applied = surface.readViewport();
    return applied
      ? { status: "applied", applied }
      : {
          status: "failed",
          applied: fallbackViewport(options),
          error: "Browser viewport target is unavailable",
        };
  };
}

function surfaceResetAdapter(
  options: ViewportCoordinatorFactoryOptions,
  coordinator: ViewportCoordinator,
): (operation: ViewportHostResetOperation) => Promise<ViewportHostResetResult> {
  return async (operation) => {
    const surface = options.surface;
    if (!surface?.resetViewport) {
      return {
        status: "failed",
        applied: null,
        error: "Browser viewport reset target is unavailable",
      };
    }
    if (!surface.resetViewport(operation, coordinator)) {
      return {
        status: "stale",
        applied: null,
        error: "Browser viewport target is no longer current",
      };
    }
    await surface.waitForLayout?.();
    if (surface.isCurrent && !surface.isCurrent(operation, coordinator)) {
      return {
        status: "stale",
        applied: null,
        error: "Browser viewport target is no longer current",
      };
    }
    return { status: "applied", applied: null };
  };
}

/** Create the single coordinator for one Browser surface. */
export function createViewportCoordinator(
  options: ViewportCoordinatorFactoryOptions,
): ViewportCoordinator {
  const coordinator: ViewportCoordinator = new ViewportCoordinator({
    initial: options.initial,
    mode: options.mode,
    presentation: options.presentation,
    targetGeneration: options.targetGeneration,
    operationId: options.operationId,
    onStateChange: (state) => {
      options.onStateChange?.(state, coordinator);
    },
    applyPresentation: async (operation) => {
      return {
        status: "applied",
        applied: operation.presentation,
        appliedViewport: fallbackViewport(options),
      };
    },
    reset: async (operation) => {
      return surfaceResetAdapter(options, coordinator)(operation);
    },
    apply: async (operation): Promise<ViewportHostResult> => {
      return surfaceViewportAdapter(options, coordinator)(operation);
    },
  });
  return coordinator;
}

/**
 * Reuse a target coordinator or register one created by the shared factory.
 * Reuse updates only target generation; the initial operation and surface closures remain authoritative.
 */
export function getOrCreateViewportCoordinator(
  options: GetOrCreateViewportCoordinatorOptions,
): ViewportCoordinator {
  if (options.existing) {
    options.existing.setTargetGeneration(options.targetGeneration);
    return options.existing;
  }
  const coordinator = createViewportCoordinator(options);
  options.onCreated?.(coordinator);
  return coordinator;
}
