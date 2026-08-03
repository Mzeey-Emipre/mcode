import {
  DEFAULT_VIEWPORT_SIZE,
  MIN_VIEWPORT_CSS_PX,
  ViewportCoordinator,
  type ViewportCoordinatorOptions,
  type ViewportHostOperation,
  type ViewportHostResult,
  type ViewportSize,
} from "./viewportCoordinator";

/** Exact Browser target that owns one viewport coordinator. */
export interface ViewportCoordinatorTarget {
  readonly threadId: string;
  readonly tabId: string;
}

/** Native design-mode result used by the shared viewport host adapter. */
export type ViewportNativeHostResult =
  | {
      readonly ok: true;
      readonly data: ViewportSize;
      readonly appliedViewport: ViewportSize;
      readonly operationId?: string;
      readonly source?: "user" | "agent";
      readonly targetGeneration?: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly appliedViewport: ViewportSize | null;
      readonly operationId?: string;
      readonly source?: "user" | "agent";
      readonly targetGeneration?: number;
    };

/** Native design-mode surface required by the viewport host adapter. */
export interface ViewportNativeHost {
  setViewport(payload: {
    readonly widthOverride: number;
    readonly heightOverride: number;
    readonly operationId: string;
    readonly source: "user" | "agent";
    readonly targetGeneration: number;
    readonly threadId: string;
    readonly tabId: string;
  }): Promise<ViewportNativeHostResult>;
}

/** Renderer-owned viewport surface used when no native design host exists. */
export interface ViewportRendererHost {
  readonly setViewport: (size: ViewportSize) => void;
  readonly readViewport: () => ViewportSize | null;
  readonly waitForLayout?: () => Promise<void>;
}

/** Inputs shared by every runtime-specific viewport coordinator creation path. */
export interface ViewportCoordinatorFactoryOptions {
  readonly target: ViewportCoordinatorTarget;
  readonly targetGeneration: number;
  readonly initial?: ViewportSize;
  readonly nativeHost?: () => ViewportNativeHost | undefined;
  readonly rendererHost?: ViewportRendererHost;
  readonly readConfirmed?: () => ViewportSize | null;
  readonly operationId?: ViewportCoordinatorOptions["operationId"];
  readonly onStateChange?: ViewportCoordinatorOptions["onStateChange"];
}

/** Options for reusing a per-tab coordinator or creating it once. */
export interface GetOrCreateViewportCoordinatorOptions extends ViewportCoordinatorFactoryOptions {
  readonly existing?: ViewportCoordinator;
  readonly onCreated?: (coordinator: ViewportCoordinator) => void;
}

function fallbackViewport(options: ViewportCoordinatorFactoryOptions): ViewportSize {
  return options.readConfirmed?.() ?? options.initial ?? DEFAULT_VIEWPORT_SIZE;
}

function identityMatches(operation: ViewportHostOperation, result: ViewportNativeHostResult): boolean {
  return result.operationId === operation.operationId &&
    result.source === operation.source &&
    result.targetGeneration === operation.targetGeneration;
}

function nativeViewportHost(
  options: ViewportCoordinatorFactoryOptions,
  nativeHost: ViewportNativeHost,
): (operation: ViewportHostOperation) => Promise<ViewportHostResult> {
  return async (operation) => {
    const fallback = fallbackViewport(options);
    const result = await nativeHost.setViewport({
      widthOverride: operation.requested.width,
      heightOverride: operation.requested.height,
      operationId: operation.operationId,
      source: operation.source,
      targetGeneration: operation.targetGeneration,
      threadId: options.target.threadId,
      tabId: options.target.tabId,
    });
    const applied = result.appliedViewport ?? fallback;
    if (!result.ok) {
      return {
        status: result.error === "stale-target" || result.error === "stale-target-generation"
          ? "stale"
          : "failed",
        applied,
        error: result.error,
      };
    }
    if (!identityMatches(operation, result)) {
      return {
        status: "stale",
        applied,
        error: "Browser viewport host acknowledgement is stale",
      };
    }
    if (result.data.width < MIN_VIEWPORT_CSS_PX || result.data.height < MIN_VIEWPORT_CSS_PX) {
      return {
        status: "failed",
        applied,
        error: "Browser viewport host bounds are below the minimum size",
      };
    }
    return { status: "applied", applied };
  };
}

function rendererViewportHost(
  options: ViewportCoordinatorFactoryOptions,
): (operation: ViewportHostOperation) => Promise<ViewportHostResult> {
  return async (operation) => {
    const rendererHost = options.rendererHost;
    if (!rendererHost) {
      return {
        status: "failed",
        applied: fallbackViewport(options),
        error: "Browser viewport target is unavailable",
      };
    }
    rendererHost.setViewport(operation.requested);
    await rendererHost.waitForLayout?.();
    const applied = rendererHost.readViewport();
    return applied
      ? { status: "applied", applied }
      : {
          status: "failed",
          applied: fallbackViewport(options),
          error: "Browser viewport target is unavailable",
        };
  };
}

function createViewportHost(
  options: ViewportCoordinatorFactoryOptions,
): (operation: ViewportHostOperation) => Promise<ViewportHostResult> {
  return async (operation) => {
    const nativeHost = options.nativeHost?.();
    if (nativeHost) return nativeViewportHost(options, nativeHost)(operation);
    return rendererViewportHost(options)(operation);
  };
}

/** Create the single coordinator and runtime-selected host adapter for one tab. */
export function createViewportCoordinator(
  options: ViewportCoordinatorFactoryOptions,
): ViewportCoordinator {
  return new ViewportCoordinator({
    initial: options.initial,
    targetGeneration: options.targetGeneration,
    operationId: options.operationId,
    onStateChange: options.onStateChange,
    apply: createViewportHost(options),
  });
}

/** Reuse a target coordinator or register one created by the shared factory. */
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
