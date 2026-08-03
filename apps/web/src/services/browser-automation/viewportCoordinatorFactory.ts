import {
  DEFAULT_VIEWPORT_SIZE,
  MIN_VIEWPORT_CSS_PX,
  ViewportCoordinator,
  type ViewportCoordinatorOptions,
  type ViewportHostOperation,
  type ViewportHostResult,
  type ViewportHostResetOperation,
  type ViewportHostResetResult,
  type ViewportPresentationHostOperation,
  type ViewportPresentationHostResult,
  type ViewportPresentation,
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

/** Native acknowledgement returned after Regular mode removes an explicit viewport. */
export type ViewportNativeResetResult =
  | {
      readonly ok: true;
      readonly appliedViewport: ViewportSize | null;
      readonly operationId?: string;
      readonly source?: "user" | "agent";
      readonly targetGeneration?: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly appliedViewport?: ViewportSize | null;
      readonly operationId?: string;
      readonly source?: "user" | "agent";
      readonly targetGeneration?: number;
    };

/** Native acknowledgement returned after a Fit or Actual presentation change. */
export type ViewportNativePresentationResult =
  | {
      readonly ok: true;
      readonly presentation: ViewportPresentation;
      readonly appliedViewport: ViewportSize;
      readonly operationId?: string;
      readonly source?: "user" | "agent";
      readonly targetGeneration?: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly presentation?: ViewportPresentation;
      readonly appliedViewport?: ViewportSize | null;
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
  setPresentation(payload: {
    readonly presentation: ViewportPresentation;
    readonly operationId: string;
    readonly source: "user" | "agent";
    readonly targetGeneration: number;
    readonly threadId: string;
    readonly tabId: string;
  }): Promise<ViewportNativePresentationResult>;
  resetViewport?(payload: {
    readonly operationId: string;
    readonly source: "user" | "agent";
    readonly targetGeneration: number;
    readonly threadId: string;
    readonly tabId: string;
  }): Promise<ViewportNativeResetResult>;
}

/** Renderer-owned viewport surface used when no native design host exists. */
export interface ViewportRendererHost {
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

/** Inputs shared by every runtime-specific viewport coordinator creation path. */
export interface ViewportCoordinatorFactoryOptions {
  readonly target: ViewportCoordinatorTarget;
  readonly targetGeneration: number;
  readonly initial?: ViewportSize;
  readonly presentation?: ViewportPresentation;
  readonly nativeHost?: () => ViewportNativeHost | undefined;
  readonly rendererHost?: ViewportRendererHost;
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

function fallbackViewport(options: ViewportCoordinatorFactoryOptions): ViewportSize {
  return options.readConfirmed?.() ?? options.initial ?? DEFAULT_VIEWPORT_SIZE;
}

function identityMatches(operation: ViewportHostOperation, result: ViewportNativeHostResult): boolean {
  return result.operationId === operation.operationId &&
    result.source === operation.source &&
    result.targetGeneration === operation.targetGeneration;
}

function presentationIdentityMatches(
  operation: ViewportPresentationHostOperation,
  result: ViewportNativePresentationResult,
): boolean {
  return result.operationId === operation.operationId &&
    result.source === operation.source &&
    result.targetGeneration === operation.targetGeneration;
}

function resetIdentityMatches(
  operation: ViewportHostResetOperation,
  result: ViewportNativeResetResult,
): boolean {
  return result.operationId === operation.operationId &&
    result.source === operation.source &&
    result.targetGeneration === operation.targetGeneration;
}

function nativePresentationHost(
  options: ViewportCoordinatorFactoryOptions,
  nativeHost: ViewportNativeHost,
): (operation: ViewportPresentationHostOperation) => Promise<ViewportPresentationHostResult> {
  return async (operation) => {
    const result = await nativeHost.setPresentation({
      presentation: operation.presentation,
      operationId: operation.operationId,
      source: operation.source,
      targetGeneration: operation.targetGeneration,
      threadId: options.target.threadId,
      tabId: options.target.tabId,
    });
    const appliedViewport = result.appliedViewport ?? fallbackViewport(options);
    const appliedPresentation = result.presentation ?? options.presentation ?? "fit";
    if (!result.ok) {
      return {
        status: result.error === "stale-target" || result.error === "stale-target-generation"
          ? "stale"
          : "failed",
        applied: appliedPresentation,
        appliedViewport,
        error: result.error,
      };
    }
    if (!presentationIdentityMatches(operation, result) || result.presentation !== operation.presentation) {
      return {
        status: "stale",
        applied: appliedPresentation,
        appliedViewport,
        error: "Browser presentation host acknowledgement is stale",
      };
    }
    return {
      status: "applied",
      applied: result.presentation,
      appliedViewport,
    };
  };
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

function nativeResetHost(
  options: ViewportCoordinatorFactoryOptions,
  nativeHost: ViewportNativeHost,
): (operation: ViewportHostResetOperation) => Promise<ViewportHostResetResult> {
  return async (operation) => {
    if (!nativeHost.resetViewport) {
      return {
        status: "failed",
        applied: null,
        error: "Browser viewport reset host is unavailable",
      };
    }
    const result = await nativeHost.resetViewport({
      operationId: operation.operationId,
      source: operation.source,
      targetGeneration: operation.targetGeneration,
      threadId: options.target.threadId,
      tabId: options.target.tabId,
    });
    if (!result.ok) {
      return {
        status: result.error === "stale-target" || result.error === "stale-target-generation"
          ? "stale"
          : "failed",
        applied: result.appliedViewport ?? null,
        error: result.error,
      };
    }
    if (!resetIdentityMatches(operation, result)) {
      return {
        status: "stale",
        applied: result.appliedViewport ?? null,
        error: "Browser viewport reset acknowledgement is stale",
      };
    }
    return { status: "applied", applied: result.appliedViewport ?? null };
  };
}

function rendererViewportHost(
  options: ViewportCoordinatorFactoryOptions,
  coordinator: ViewportCoordinator,
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
    if (!rendererHost.setViewport(operation.requested, operation, coordinator)) {
      return {
        status: "stale",
        applied: fallbackViewport(options),
        error: "Browser viewport target is no longer current",
      };
    }
    await rendererHost.waitForLayout?.();
    if (rendererHost.isCurrent && !rendererHost.isCurrent(operation, coordinator)) {
      return {
        status: "stale",
        applied: fallbackViewport(options),
        error: "Browser viewport target is no longer current",
      };
    }
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

function rendererResetHost(
  options: ViewportCoordinatorFactoryOptions,
  coordinator: ViewportCoordinator,
): (operation: ViewportHostResetOperation) => Promise<ViewportHostResetResult> {
  return async (operation) => {
    const rendererHost = options.rendererHost;
    if (!rendererHost?.resetViewport) {
      return {
        status: "failed",
        applied: null,
        error: "Browser viewport reset target is unavailable",
      };
    }
    if (!rendererHost.resetViewport(operation, coordinator)) {
      return {
        status: "stale",
        applied: null,
        error: "Browser viewport target is no longer current",
      };
    }
    await rendererHost.waitForLayout?.();
    if (rendererHost.isCurrent && !rendererHost.isCurrent(operation, coordinator)) {
      return {
        status: "stale",
        applied: null,
        error: "Browser viewport target is no longer current",
      };
    }
    return { status: "applied", applied: null };
  };
}

function createViewportHost(
  options: ViewportCoordinatorFactoryOptions,
  coordinator: ViewportCoordinator,
): (operation: ViewportHostOperation) => Promise<ViewportHostResult> {
  return async (operation) => {
    const nativeHost = options.nativeHost?.();
    if (nativeHost && typeof nativeHost.setViewport === "function") {
      return nativeViewportHost(options, nativeHost)(operation);
    }
    return rendererViewportHost(options, coordinator)(operation);
  };
}

/** Create the single coordinator and runtime-selected host adapter for one tab. */
export function createViewportCoordinator(
  options: ViewportCoordinatorFactoryOptions,
): ViewportCoordinator {
  const coordinator: ViewportCoordinator = new ViewportCoordinator({
    initial: options.initial,
    presentation: options.presentation,
    targetGeneration: options.targetGeneration,
    operationId: options.operationId,
    onStateChange: (state) => {
      options.onStateChange?.(state, coordinator);
    },
    applyPresentation: async (operation) => {
      const nativeHost = options.nativeHost?.();
      if (nativeHost && typeof nativeHost.setPresentation === "function") {
        return nativePresentationHost(options, nativeHost)(operation);
      }
      return {
        status: "applied",
        applied: operation.presentation,
        appliedViewport: fallbackViewport(options),
      };
    },
    reset: async (operation) => {
      const nativeHost = options.nativeHost?.();
      if (nativeHost && typeof nativeHost.resetViewport === "function") {
        const result = await nativeResetHost(options, nativeHost)(operation);
        if (result.status === "applied") {
          options.rendererHost?.resetViewport?.(operation, coordinator);
        }
        return result;
      }
      return rendererResetHost(options, coordinator)(operation);
    },
    apply: async (operation): Promise<ViewportHostResult> => {
      return createViewportHost(options, coordinator)(operation);
    },
  });
  return coordinator;
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
