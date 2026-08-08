import { BROWSER_TAB_INFO_STRING_MAX } from "@mcode/contracts";
import { normalizeBrowserSurfaceAddress } from "./browserSurfaceAddress";

/** Complete identity of one Browser surface in a renderer window. */
export interface BrowserSurfaceIdentity {
  readonly workspaceId: string;
  readonly scope: {
    readonly kind: "thread" | "workspace";
    readonly id: string;
  };
  readonly tabId: string;
}

/** Known page phases exposed by a Browser surface. */
export type BrowserSurfacePagePhase = "loading" | "loaded" | "error";

/** Whether the web adapter can inspect the current main-frame document. */
export type BrowserSurfaceDocumentAccess = "same-origin" | "cross-origin" | "unknown";

/** History capabilities observed by an adapter, or null when history is unknown. */
export interface BrowserSurfaceNavigationState {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** Canonical, generation-bound page state for one Browser surface. */
export interface BrowserSurfacePageState {
  readonly identity: BrowserSurfaceIdentity;
  readonly generation: number;
  readonly pendingAddress: string | null;
  readonly committedAddress: string | null;
  readonly recoveryAddress: string | null;
  readonly title: string;
  readonly favicon: string | null;
  readonly phase: BrowserSurfacePagePhase;
  readonly mainFrameError: string | null;
  readonly navigation: BrowserSurfaceNavigationState | null;
  readonly documentAccess: BrowserSurfaceDocumentAccess;
}

/** Shared fields carried by every semantic adapter event. */
export interface BrowserSurfaceAdapterEventBase {
  readonly identity: BrowserSurfaceIdentity;
  readonly generation: number;
}

/** Semantic events emitted by native and iframe Browser surface adapters. */
export type BrowserSurfaceAdapterEvent = BrowserSurfaceAdapterEventBase & (
  | { readonly type: "navigation-started"; readonly mainFrame: boolean; readonly address: string }
  | { readonly type: "navigation-committed"; readonly mainFrame: boolean; readonly address: string }
  | { readonly type: "load-started"; readonly mainFrame: boolean; readonly address?: string }
  | {
      readonly type: "load-failed";
      readonly mainFrame: boolean;
      readonly address?: string;
      readonly error?: string;
      readonly errorCode?: string | number;
      readonly expected?: boolean;
      readonly isExpected?: boolean;
    }
  | { readonly type: "load-stopped"; readonly mainFrame: boolean; readonly address?: string }
  | { readonly type: "title-updated"; readonly title: string | null }
  | { readonly type: "favicon-updated"; readonly favicon: string | null }
  | { readonly type: "navigation-state"; readonly navigation: BrowserSurfaceNavigationState | null }
  | { readonly type: "document-access"; readonly access: BrowserSurfaceDocumentAccess }
);

/** Event payload accepted by adapter test doubles before identity is attached. */
export type BrowserSurfaceAdapterEventPayload = BrowserSurfaceAdapterEvent extends infer Event
  ? Event extends BrowserSurfaceAdapterEvent
    ? Omit<Event, "identity" | "generation">
    : never
  : never;

/** Adapter owned by a BrowserSurfaceHost for one identity and generation. */
export interface BrowserSurfaceAdapter {
  /** Materializes the adapter's DOM/native resource. */
  create?(): void;
  /** Presents the resource in its host container. */
  present(presentation?: BrowserSurfacePresentation): void;
  /** Occludes the resource without releasing it. */
  hide(): void;
  /** Starts navigation to a validated address. */
  navigate(address: string): void | Promise<void>;
  /** Subscribes to semantic adapter events. */
  subscribe(listener: (event: BrowserSurfaceAdapterEvent) => void): () => void;
  /** Releases the adapter's resource and listeners. */
  dispose(): void;
}

/** Bounded viewport placement supplied by the root host for presentation. */
export interface BrowserSurfacePresentation {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly scale?: number;
  readonly zIndex?: number;
}

/** Factory that creates the adapter for one complete identity and generation. */
export type BrowserSurfaceAdapterFactory = (
  identity: BrowserSurfaceIdentity,
  generation: number,
) => BrowserSurfaceAdapter;

/** Deterministic scheduling hooks used by BrowserSurfaceHost publication. */
export interface BrowserSurfaceScheduling {
  readonly requestAnimationFrame: (callback: () => void) => number;
  readonly cancelAnimationFrame: (handle: number) => void;
  readonly queueTask?: (callback: () => void) => void;
}

/** Visibility hooks used to pause publication for hidden renderer documents. */
export interface BrowserSurfaceVisibility {
  readonly isHidden: () => boolean;
  readonly subscribe: (listener: (hidden?: boolean) => void) => () => void;
}

/** Host dependencies. Both the adapter and publication scheduler are injected. */
export interface BrowserSurfaceHostOptions {
  readonly adapterFactory: BrowserSurfaceAdapterFactory;
  readonly normalizeAddress?: (address: string) => string;
  readonly scheduling?: BrowserSurfaceScheduling;
  readonly visibility?: BrowserSurfaceVisibility;
}

/** Optional creation parameters for an identity-bound Browser surface. */
export interface BrowserSurfaceCreateOptions {
  readonly address?: string;
  readonly generation?: number;
}

/** Listener invoked when a generation's canonical state is published. */
export type BrowserSurfaceListener = (snapshot: BrowserSurfacePageState) => void;

const MAX_ADDRESS = BROWSER_TAB_INFO_STRING_MAX.url;
const MAX_TITLE = BROWSER_TAB_INFO_STRING_MAX.title;
const MAX_FAVICON = BROWSER_TAB_INFO_STRING_MAX.faviconUrl;

function surfaceKey(identity: BrowserSurfaceIdentity): string {
  return JSON.stringify([identity.workspaceId, identity.scope.kind, identity.scope.id, identity.tabId]);
}

function boundString(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  return String(value).slice(0, max);
}

function sameIdentity(left: BrowserSurfaceIdentity, right: BrowserSurfaceIdentity): boolean {
  return left.workspaceId === right.workspaceId &&
    left.scope.kind === right.scope.kind &&
    left.scope.id === right.scope.id &&
    left.tabId === right.tabId;
}

function defaultScheduling(): BrowserSurfaceScheduling {
  const requestAnimationFrame = typeof globalThis.requestAnimationFrame === "function"
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : (callback: () => void) => Number(globalThis.setTimeout(callback, 0));
  const cancelAnimationFrame = typeof globalThis.cancelAnimationFrame === "function"
    ? globalThis.cancelAnimationFrame.bind(globalThis)
    : (handle: number) => globalThis.clearTimeout(handle);
  return { requestAnimationFrame, cancelAnimationFrame, queueTask: (callback) => { globalThis.setTimeout(callback, 0); } };
}

function defaultVisibility(): BrowserSurfaceVisibility {
  const documentRef = typeof document === "undefined" ? null : document;
  const listeners = new Set<(hidden?: boolean) => void>();
  const notify = (): void => {
    const hidden = documentRef?.visibilityState === "hidden";
    for (const listener of listeners) listener(hidden);
  };
  documentRef?.addEventListener("visibilitychange", notify);
  return {
    isHidden: () => documentRef?.visibilityState === "hidden",
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) documentRef?.removeEventListener("visibilitychange", notify);
      };
    },
  };
}

function initialPageState(identity: BrowserSurfaceIdentity, generation: number, address?: string): BrowserSurfacePageState {
  const pendingAddress = boundString(address, MAX_ADDRESS);
  return {
    identity,
    generation,
    pendingAddress,
    committedAddress: null,
    recoveryAddress: null,
    title: "",
    favicon: null,
    phase: "loading",
    mainFrameError: null,
    navigation: null,
    documentAccess: "unknown",
  };
}

function eventIsExpectedAbort(event: Extract<BrowserSurfaceAdapterEvent, { type: "load-failed" }>): boolean {
  return event.expected === true || event.isExpected === true || event.errorCode === -3 || event.errorCode === "ERR_ABORTED";
}

function boundedNumber(value: number, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function boundPresentation(presentation: BrowserSurfacePresentation): BrowserSurfacePresentation {
  return {
    left: boundedNumber(presentation.left, 0, -100_000, 100_000),
    top: boundedNumber(presentation.top, 0, -100_000, 100_000),
    width: boundedNumber(presentation.width, 1, 1, 10_000),
    height: boundedNumber(presentation.height, 1, 1, 10_000),
    ...(presentation.scale === undefined ? {} : { scale: boundedNumber(presentation.scale, 1, 0.1, 10) }),
    ...(presentation.zIndex === undefined ? {} : { zIndex: Math.round(boundedNumber(presentation.zIndex, 0, -2_147_483_648, 2_147_483_647)) }),
  };
}

function sameStateValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftNavigation = left as BrowserSurfaceNavigationState;
  const rightNavigation = right as BrowserSurfaceNavigationState;
  return "canGoBack" in leftNavigation && "canGoForward" in leftNavigation &&
    "canGoBack" in rightNavigation && "canGoForward" in rightNavigation &&
    leftNavigation.canGoBack === rightNavigation.canGoBack &&
    leftNavigation.canGoForward === rightNavigation.canGoForward;
}

/**
 * Owns Browser surface adapters, generation-bound canonical state, and
 * identity-scoped frame-batched publication.
 */
export class BrowserSurfaceHost {
  private readonly records = new Map<string, SurfaceRecord>();
  private readonly scheduling: BrowserSurfaceScheduling;
  private readonly visibility: BrowserSurfaceVisibility;
  private readonly normalizeAddress: (address: string) => string;
  private readonly stopVisibility: () => void;
  private nextGeneration = 1;

  /** Creates a host with injected adapter, scheduling, and visibility seams. */
  public constructor(options: BrowserSurfaceHostOptions) {
    this.scheduling = options.scheduling ?? defaultScheduling();
    this.visibility = options.visibility ?? defaultVisibility();
    this.normalizeAddress = options.normalizeAddress ?? normalizeBrowserSurfaceAddress;
    this.stopVisibility = this.visibility.subscribe((hidden) => {
      if (hidden ?? this.visibility.isHidden()) return;
      this.publishVisibleRecords();
    });
    this.adapterFactory = options.adapterFactory;
  }

  private readonly adapterFactory: BrowserSurfaceAdapterFactory;

  /** Creates or replaces the adapter for an identity and returns its snapshot. */
  public create(identity: BrowserSurfaceIdentity, optionsOrGeneration: BrowserSurfaceCreateOptions | number = {}): BrowserSurfacePageState {
    const options: BrowserSurfaceCreateOptions = typeof optionsOrGeneration === "number"
      ? { generation: optionsOrGeneration }
      : optionsOrGeneration;
    const key = surfaceKey(identity);
    const prior = this.records.get(key);
    const address = options.address === undefined
      ? undefined
      : this.normalizeAddress(options.address);
    const generation = options.generation ?? (prior ? prior.generation + 1 : this.nextGeneration++);
    if (prior && options.generation !== undefined && generation <= prior.generation) return prior.state;
    if (generation >= this.nextGeneration) this.nextGeneration = generation + 1;
    if (prior) this.disposeRecord(key, prior, false);
    const adapter = this.adapterFactory(identity, generation);
    const record: SurfaceRecord = {
      identity,
      generation,
      adapter,
      state: initialPageState(identity, generation, address),
      listeners: prior?.listeners ?? new Set(),
      stopAdapter: () => undefined,
      frameHandle: null,
      publicationPending: prior !== undefined,
      disposed: false,
    };
    this.records.set(key, record);
    record.stopAdapter = adapter.subscribe((event) => this.handleEvent(event));
    adapter.create?.();
    if (address !== undefined) void adapter.navigate(address);
    if (record.publicationPending) this.schedulePublication(record);
    return record.state;
  }

  /** Returns an identity's warm surface, or creates it when it does not exist. */
  public ensure(identity: BrowserSurfaceIdentity, options: BrowserSurfaceCreateOptions = {}): BrowserSurfacePageState {
    const current = this.records.get(surfaceKey(identity));
    if (current && sameIdentity(current.identity, identity)) return current.state;
    return this.create(identity, options);
  }

  /** Makes an identity's current surface visible without changing its generation. */
  public present(identity: BrowserSurfaceIdentity, presentation: BrowserSurfacePresentation = {
    left: 0,
    top: 0,
    width: 1,
    height: 1,
  }): void {
    const record = this.records.get(surfaceKey(identity));
    if (!record || !sameIdentity(record.identity, identity)) return;
    record.adapter.present(boundPresentation(presentation));
  }

  /** Hides an identity's current surface while retaining the live adapter. */
  public hide(identity: BrowserSurfaceIdentity): void {
    const record = this.records.get(surfaceKey(identity));
    if (!record || !sameIdentity(record.identity, identity)) return;
    record.adapter.hide();
  }

  /** Requests navigation and synchronously enters the loading phase. */
  public navigate(identity: BrowserSurfaceIdentity, address: string): void {
    const record = this.records.get(surfaceKey(identity));
    if (!record || !sameIdentity(record.identity, identity)) return;
    const normalized = this.normalizeAddress(address);
    this.reduce(record, { type: "navigation-started", identity, generation: record.generation, mainFrame: true, address: normalized });
    void record.adapter.navigate(normalized);
  }

  /** Alias for callers that name the operation as a navigation request. */
  public requestNavigation(identity: BrowserSurfaceIdentity, address: string): void {
    this.navigate(identity, address);
  }

  /** Applies one semantic adapter event when its identity and generation are current. */
  public handleEvent(event: BrowserSurfaceAdapterEvent): void {
    const record = this.records.get(surfaceKey(event.identity));
    if (!record || record.disposed || record.generation !== event.generation || !sameIdentity(record.identity, event.identity)) return;
    this.reduce(record, event);
  }

  /** Reads the current canonical snapshot for one identity. */
  public getSnapshot(identity: BrowserSurfaceIdentity): BrowserSurfacePageState | null {
    return this.records.get(surfaceKey(identity))?.state ?? null;
  }

  /** Subscribes to one identity; listeners never receive another identity's state. */
  public subscribe(identity: BrowserSurfaceIdentity, listener: BrowserSurfaceListener): () => void {
    const record = this.records.get(surfaceKey(identity));
    if (!record || !sameIdentity(record.identity, identity)) return () => undefined;
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  /** Disposes an identity and cancels any queued publication for its generation. */
  public dispose(identity: BrowserSurfaceIdentity): void {
    const key = surfaceKey(identity);
    const record = this.records.get(key);
    if (!record || !sameIdentity(record.identity, identity)) return;
    this.disposeRecord(key, record, true);
  }

  /** Releases host-level visibility resources. */
  public disposeHost(): void {
    this.stopVisibility();
    this.disposeAll();
  }

  /** Disposes every surface while retaining host-level visibility resources. */
  public disposeAll(): void {
    for (const [key, record] of this.records) this.disposeRecord(key, record, true);
  }

  private disposeRecord(key: string, record: SurfaceRecord, remove: boolean): void {
    record.disposed = true;
    if (record.frameHandle !== null) this.scheduling.cancelAnimationFrame(record.frameHandle);
    record.frameHandle = null;
    record.publicationPending = false;
    record.stopAdapter();
    record.adapter.dispose();
    if (remove) record.listeners.clear();
    if (remove && this.records.get(key) === record) this.records.delete(key);
  }

  private reduce(record: SurfaceRecord, event: BrowserSurfaceAdapterEvent): void {
    const previous = record.state;
    const next = this.nextState(previous, event);
    if (next === previous) return;
    record.state = next;
    record.publicationPending = true;
    this.schedulePublication(record);
  }

  private nextState(state: BrowserSurfacePageState, event: BrowserSurfaceAdapterEvent): BrowserSurfacePageState {
    if (!sameIdentity(state.identity, event.identity) || state.generation !== event.generation) return state;
    switch (event.type) {
      case "navigation-started":
        if (!event.mainFrame) return state;
        return this.mergeState(state, {
          pendingAddress: boundString(event.address, MAX_ADDRESS),
          phase: "loading",
          mainFrameError: null,
        });
      case "navigation-committed":
        if (!event.mainFrame) return state;
        return this.mergeState(state, {
          committedAddress: boundString(event.address, MAX_ADDRESS),
          recoveryAddress: boundString(event.address, MAX_ADDRESS),
        });
      case "load-started":
        if (!event.mainFrame) return state;
        return this.mergeState(state, {
          ...(event.address === undefined ? {} : { pendingAddress: boundString(event.address, MAX_ADDRESS) }),
          phase: "loading",
          mainFrameError: null,
        });
      case "load-failed":
        if (!event.mainFrame || eventIsExpectedAbort(event)) return state;
        return this.mergeState(state, {
          ...(event.address === undefined ? {} : { pendingAddress: boundString(event.address, MAX_ADDRESS) }),
          phase: "error",
          mainFrameError: boundString(event.error ?? (typeof event.errorCode === "number" ? String(event.errorCode) : event.errorCode), 500),
        });
      case "load-stopped":
        if (!event.mainFrame || state.phase === "error") return state;
        return this.mergeState(state, {
          ...(event.address === undefined ? {} : {
            committedAddress: boundString(event.address, MAX_ADDRESS),
            recoveryAddress: boundString(event.address, MAX_ADDRESS),
          }),
          pendingAddress: null,
          phase: "loaded",
        });
      case "title-updated":
        return this.mergeState(state, { title: boundString(event.title, MAX_TITLE) ?? "" });
      case "favicon-updated":
        return this.mergeState(state, { favicon: boundString(event.favicon, MAX_FAVICON) });
      case "navigation-state":
        return this.mergeState(state, { navigation: event.navigation });
      case "document-access":
        return this.mergeState(state, { documentAccess: event.access });
    }
  }

  private mergeState(
    state: BrowserSurfacePageState,
    patch: Partial<Omit<BrowserSurfacePageState, "identity" | "generation">>,
  ): BrowserSurfacePageState {
    const next = { ...state, ...patch };
    return Object.keys(next).some((key) => !sameStateValue(
      next[key as keyof BrowserSurfacePageState],
      state[key as keyof BrowserSurfacePageState],
    ))
      ? next
      : state;
  }

  private schedulePublication(record: SurfaceRecord): void {
    if (record.frameHandle !== null || this.visibility.isHidden()) return;
    record.frameHandle = this.scheduling.requestAnimationFrame(() => {
      record.frameHandle = null;
      if (record.disposed || this.visibility.isHidden()) return;
      if (!record.publicationPending) return;
      record.publicationPending = false;
      for (const listener of [...record.listeners]) listener(record.state);
    });
  }

  private publishVisibleRecords(): void {
    if (this.visibility.isHidden()) return;
    for (const record of this.records.values()) {
      if (!record.publicationPending) continue;
      this.schedulePublication(record);
    }
  }
}

interface SurfaceRecord {
  readonly identity: BrowserSurfaceIdentity;
  readonly generation: number;
  readonly adapter: BrowserSurfaceAdapter;
  readonly listeners: Set<BrowserSurfaceListener>;
  state: BrowserSurfacePageState;
  stopAdapter: () => void;
  frameHandle: number | null;
  publicationPending: boolean;
  disposed: boolean;
}
