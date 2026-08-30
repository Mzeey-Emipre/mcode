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
  readonly mainFrameErrorCode: string | number | null;
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
  | { readonly type: "surface-lost"; readonly nextGeneration?: number }
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
  /** Updates the visible agent-control indicator without changing page input. */
  setControlled?(controlled: boolean): void;
  /** Occludes the resource without releasing it. */
  hide(): void;
  /** Starts navigation to a validated address. */
  navigate(address: string): void | Promise<void>;
  /** Subscribes to semantic adapter events. */
  subscribe(listener: (event: BrowserSurfaceAdapterEvent) => void): () => void;
  /** Releases the adapter's resource and listeners. */
  dispose(reason?: BrowserSurfaceDisposalReason): void;
}

/** Why a generation-bound adapter stopped owning its surface. */
export type BrowserSurfaceDisposalReason = "discard" | "replace" | "dispose" | "loss";

/** Bounded viewport placement supplied by the root host for presentation. */
export interface BrowserSurfacePresentation {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly scale?: number;
  readonly zIndex?: number;
  /** Width hidden at the left edge while the full Browser viewport remains unchanged. */
  readonly coveredLeft?: number;
  /** Whether the detached surface accepts pointer and keyboard input. */
  readonly inputEnabled?: boolean;
  /** Whether the detached surface is exposed to the accessibility tree. */
  readonly accessible?: boolean;
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

/** Bounded lifecycle metadata retained while a Browser tab is cold. */
export interface BrowserSurfaceMetadata {
  readonly identity: BrowserSurfaceIdentity;
  readonly residency: "warm" | "cold";
  readonly generation: number;
  readonly recoveryAddress: string | null;
  readonly title: string;
  readonly favicon: string | null;
}

type RetainedBrowserSurfaceMetadata = Pick<
  BrowserSurfaceMetadata,
  "recoveryAddress" | "title" | "favicon"
>;

/** Listener invoked when a generation's canonical state is published. */
export type BrowserSurfaceListener = (snapshot: BrowserSurfacePageState) => void;

/** Listener invoked whenever a warm generation is materialized. */
export type BrowserSurfaceMaterializedListener = (
  identity: BrowserSurfaceIdentity,
  generation: number,
) => void;

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

function initialPageState(
  identity: BrowserSurfaceIdentity,
  generation: number,
  address?: string,
  metadata?: RetainedBrowserSurfaceMetadata,
): BrowserSurfacePageState {
  const pendingAddress = boundString(address, MAX_ADDRESS);
  return {
    identity,
    generation,
    pendingAddress,
    committedAddress: null,
    recoveryAddress: metadata?.recoveryAddress ?? pendingAddress,
    title: metadata?.title ?? "",
    favicon: metadata?.favicon ?? null,
    phase: "loading",
    mainFrameError: null,
    mainFrameErrorCode: null,
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
  const width = boundedNumber(presentation.width, 1, 1, 10_000);
  return {
    left: boundedNumber(presentation.left, 0, -100_000, 100_000),
    top: boundedNumber(presentation.top, 0, -100_000, 100_000),
    width,
    height: boundedNumber(presentation.height, 1, 1, 10_000),
    ...(presentation.scale === undefined ? {} : { scale: boundedNumber(presentation.scale, 1, 0.1, 10) }),
    ...(presentation.zIndex === undefined ? {} : { zIndex: Math.round(boundedNumber(presentation.zIndex, 0, -2_147_483_648, 2_147_483_647)) }),
    ...(presentation.coveredLeft === undefined
      ? {}
      : { coveredLeft: boundedNumber(presentation.coveredLeft, 0, 0, width) }),
    ...(presentation.inputEnabled === undefined
      ? {}
      : { inputEnabled: presentation.inputEnabled }),
    ...(presentation.accessible === undefined
      ? {}
      : { accessible: presentation.accessible }),
  };
}

function isNavigationState(value: unknown): value is BrowserSurfaceNavigationState {
  return value !== null && typeof value === "object" &&
    "canGoBack" in value && "canGoForward" in value;
}

function sameStateValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!isNavigationState(left) || !isNavigationState(right)) return false;
  return left.canGoBack === right.canGoBack && left.canGoForward === right.canGoForward;
}

/**
 * Owns Browser surface adapters, generation-bound canonical state, and
 * identity-scoped frame-batched publication.
 */
export class BrowserSurfaceHost {
  private readonly records = new Map<string, SurfaceRecord>();
  private readonly materializedListeners = new Set<BrowserSurfaceMaterializedListener>();
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
  private readonly nextStateHandlers: Record<
    BrowserSurfaceAdapterEvent["type"],
    (state: BrowserSurfacePageState, event: BrowserSurfaceAdapterEvent) => BrowserSurfacePageState
  > = {
    "navigation-started": (state, event) => this.navigationStartedState(state, event as Extract<BrowserSurfaceAdapterEvent, { type: "navigation-started" }>),
    "navigation-committed": (state, event) => this.navigationCommittedState(state, event as Extract<BrowserSurfaceAdapterEvent, { type: "navigation-committed" }>),
    "load-started": (state, event) => this.loadStartedState(state, event as Extract<BrowserSurfaceAdapterEvent, { type: "load-started" }>),
    "load-failed": (state, event) => this.loadFailedState(state, event as Extract<BrowserSurfaceAdapterEvent, { type: "load-failed" }>),
    "load-stopped": (state, event) => this.loadStoppedState(state, event as Extract<BrowserSurfaceAdapterEvent, { type: "load-stopped" }>),
    "title-updated": (state, event) => this.mergeState(state, { title: boundString((event as Extract<BrowserSurfaceAdapterEvent, { type: "title-updated" }>).title, MAX_TITLE) ?? "" }),
    "favicon-updated": (state, event) => this.mergeState(state, { favicon: boundString((event as Extract<BrowserSurfaceAdapterEvent, { type: "favicon-updated" }>).favicon, MAX_FAVICON) }),
    "navigation-state": (state, event) => this.mergeState(state, { navigation: (event as Extract<BrowserSurfaceAdapterEvent, { type: "navigation-state" }>).navigation }),
    "document-access": (state, event) => this.mergeState(state, { documentAccess: (event as Extract<BrowserSurfaceAdapterEvent, { type: "document-access" }>).access }),
    "surface-lost": (state) => state,
  };

  private createOptions(optionsOrGeneration: BrowserSurfaceCreateOptions | number): BrowserSurfaceCreateOptions {
    return typeof optionsOrGeneration === "number" ? { generation: optionsOrGeneration } : optionsOrGeneration;
  }

  private createGeneration(options: BrowserSurfaceCreateOptions, prior: SurfaceRecord | undefined): number {
    return options.generation ?? (prior ? prior.generation + 1 : this.nextGeneration++);
  }

  private validateCreateGeneration(
    prior: SurfaceRecord | undefined,
    options: BrowserSurfaceCreateOptions,
    generation: number,
  ): BrowserSurfacePageState | null {
    if (!prior || options.generation === undefined || generation > prior.generation) return null;
    if (prior.state) return prior.state;
    throw new RangeError("Cannot create a Browser surface from a retired generation");
  }

  private retainedRecordFields(
    prior: SurfaceRecord | undefined,
    metadata: RetainedBrowserSurfaceMetadata | undefined,
  ): Pick<SurfaceRecord, "title" | "favicon" | "listeners" | "publicationPending" | "visible" | "controlled" | "presentation"> {
    return {
      title: this.retainedTitle(metadata),
      favicon: this.retainedFavicon(metadata),
      listeners: this.priorField(prior, (record) => record.listeners, new Set()),
      publicationPending: prior !== undefined,
      visible: this.priorField(prior, (record) => record.visible, false),
      controlled: this.priorField(prior, (record) => record.controlled, false),
      presentation: this.priorField(prior, (record) => record.presentation, null),
    };
  }

  private priorField<Value>(prior: SurfaceRecord | undefined, select: (record: SurfaceRecord) => Value, fallback: Value): Value {
    return prior ? select(prior) : fallback;
  }

  private retainedTitle(metadata: RetainedBrowserSurfaceMetadata | undefined): string {
    return metadata ? metadata.title : "";
  }

  private retainedFavicon(metadata: RetainedBrowserSurfaceMetadata | undefined): string | null {
    return metadata ? metadata.favicon : null;
  }

  private createRecord(
    identity: BrowserSurfaceIdentity,
    generation: number,
    address: string | undefined,
    prior: SurfaceRecord | undefined,
    retainedMetadata: RetainedBrowserSurfaceMetadata | undefined,
  ): SurfaceRecord & { adapter: BrowserSurfaceAdapter; state: BrowserSurfacePageState } {
    const adapter = this.adapterFactory(identity, generation);
    const state = initialPageState(identity, generation, address, retainedMetadata);
    return {
      identity,
      generation,
      adapter,
      state,
      recoveryAddress: state.recoveryAddress,
      stopAdapter: () => undefined,
      frameHandle: null,
      disposed: false,
      operationPins: 0,
      capturePins: 0,
      ...this.retainedRecordFields(prior, retainedMetadata),
    };
  }

  private startRecord(record: SurfaceRecord, address: string | undefined): void {
    record.stopAdapter = record.adapter!.subscribe((event) => this.handleEvent(event));
    for (const listener of this.materializedListeners) listener(record.identity, record.generation);
    record.adapter!.create?.();
    record.adapter!.setControlled?.(record.controlled);
    if (address !== undefined) void record.adapter!.navigate(address);
    if (record.visible && record.presentation) record.adapter!.present(record.presentation);
    if (record.publicationPending) this.schedulePublication(record);
  }

  /** Creates or replaces the adapter for an identity and returns its snapshot. */
  public create(identity: BrowserSurfaceIdentity, optionsOrGeneration: BrowserSurfaceCreateOptions | number = {}): BrowserSurfacePageState {
    const options = this.createOptions(optionsOrGeneration);
    const key = surfaceKey(identity);
    const prior = this.records.get(key);
    const address = options.address === undefined ? undefined : this.normalizeAddress(options.address);
    const generation = this.createGeneration(options, prior);
    const current = this.validateCreateGeneration(prior, options, generation);
    if (current) return current;
    if (generation >= this.nextGeneration) this.nextGeneration = generation + 1;
    const retainedMetadata = prior ? this.metadataFor(prior) : undefined;
    if (prior) this.disposeRecord(key, prior, false);
    const record = this.createRecord(identity, generation, address, prior, retainedMetadata);
    this.records.set(key, record);
    this.startRecord(record, address);
    return record.state;
  }

  /** Returns an identity's warm surface, or creates it when it does not exist. */
  public ensure(identity: BrowserSurfaceIdentity, options: BrowserSurfaceCreateOptions = {}): BrowserSurfacePageState {
    const current = this.records.get(surfaceKey(identity));
    if (current && sameIdentity(current.identity, identity)) {
      if (current.state) return current.state;
      return this.rewarmRecord(current, options.address);
    }
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
    const bounded = boundPresentation(presentation);
    const state = record.state ?? this.rewarmRecord(record);
    const current = this.records.get(surfaceKey(identity));
    if (!current || current.state !== state || !current.adapter) return;
    current.visible = true;
    current.presentation = bounded;
    current.adapter.present(bounded);
  }

  /** Hides an identity's current surface while retaining the live adapter. */
  public hide(identity: BrowserSurfaceIdentity): void {
    const record = this.records.get(surfaceKey(identity));
    if (!record || !sameIdentity(record.identity, identity)) return;
    record.visible = false;
    record.adapter?.hide();
  }

  /** Requests navigation and synchronously enters the loading phase. */
  public navigate(identity: BrowserSurfaceIdentity, address: string): void {
    const record = this.records.get(surfaceKey(identity));
    if (!record || !sameIdentity(record.identity, identity)) return;
    if (!record.state) {
      this.rewarmRecord(record, address);
      return;
    }
    const current = this.records.get(surfaceKey(identity));
    if (!current?.state || !current.adapter) return;
    const normalized = this.normalizeAddress(address);
    this.reduce(current, { type: "navigation-started", identity, generation: current.generation, mainFrame: true, address: normalized });
    void current.adapter.navigate(normalized);
  }

  /** Alias for callers that name the operation as a navigation request. */
  public requestNavigation(identity: BrowserSurfaceIdentity, address: string): void {
    this.navigate(identity, address);
  }

  /** Applies one semantic adapter event when its identity and generation are current. */
  public handleEvent(event: BrowserSurfaceAdapterEvent): void {
    const record = this.records.get(surfaceKey(event.identity));
    if (!record || record.disposed || record.generation !== event.generation || !sameIdentity(record.identity, event.identity)) return;
    if (event.type === "surface-lost") {
      if (!record.state) return;
      this.handleUnexpectedLoss(record, event.nextGeneration);
      return;
    }
    if (!record.state) return;
    this.reduce(record, event);
  }

  /** Reads the current canonical snapshot for one identity. */
  public getSnapshot(identity: BrowserSurfaceIdentity): BrowserSurfacePageState | null {
    return this.records.get(surfaceKey(identity))?.state ?? null;
  }

  /** Reads warm or cold metadata without materializing a cold surface. */
  public inspect(identity: BrowserSurfaceIdentity): BrowserSurfaceMetadata | null {
    const record = this.records.get(surfaceKey(identity));
    if (!record || !sameIdentity(record.identity, identity)) return null;
    return {
      identity: record.identity,
      residency: record.state ? "warm" : "cold",
      generation: record.generation,
      ...this.metadataFor(record),
    };
  }

  /** Subscribes to one identity; listeners never receive another identity's state. */
  public subscribe(identity: BrowserSurfaceIdentity, listener: BrowserSurfaceListener): () => void {
    const record = this.records.get(surfaceKey(identity));
    if (!record || !sameIdentity(record.identity, identity)) return () => undefined;
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  /** Subscribes to warm generation materialization across this host. */
  public subscribeMaterialized(listener: BrowserSurfaceMaterializedListener): () => void {
    this.materializedListeners.add(listener);
    return () => this.materializedListeners.delete(listener);
  }

  /** Discards one unprotected warm generation and retains bounded recovery metadata. */
  public discard(identity: BrowserSurfaceIdentity, expectedGeneration?: number): boolean {
    const record = this.records.get(surfaceKey(identity));
    if (
      !record ||
      !record.state ||
      !sameIdentity(record.identity, identity) ||
      expectedGeneration !== undefined && record.generation !== expectedGeneration ||
      this.isProtected(record)
    ) return false;
    this.retireToCold(record);
    return true;
  }

  /** Changes agent-control protection without changing residency or generation. */
  public setControlled(identity: BrowserSurfaceIdentity, controlled: boolean): void {
    const record = this.records.get(surfaceKey(identity));
    if (!record || !sameIdentity(record.identity, identity)) return;
    record.controlled = controlled;
    record.adapter?.setControlled?.(controlled);
  }

  /** Pins a generation while an automation operation is in flight. */
  public pinOperation(identity: BrowserSurfaceIdentity, generation: number): () => void {
    return this.pin(identity, generation, "operationPins");
  }

  /** Pins a generation while capture is in flight. */
  public pinCapture(identity: BrowserSurfaceIdentity, generation: number): () => void {
    return this.pin(identity, generation, "capturePins");
  }

  /** Disposes an identity and cancels any queued publication for its generation. */
  public dispose(identity: BrowserSurfaceIdentity): void {
    const key = surfaceKey(identity);
    const record = this.records.get(key);
    if (!record || !sameIdentity(record.identity, identity)) return;
    this.disposeRecord(key, record, true);
  }

  /** Disposes every surface in one exact workspace-qualified scope. */
  public disposeScope(workspaceId: string, scope: BrowserSurfaceIdentity["scope"]): void {
    for (const [key, record] of this.records) {
      if (
        record.identity.workspaceId === workspaceId &&
        record.identity.scope.kind === scope.kind &&
        record.identity.scope.id === scope.id
      ) this.disposeRecord(key, record, true);
    }
  }

  /** Disposes every surface owned by one workspace. */
  public disposeWorkspace(workspaceId: string): void {
    for (const [key, record] of this.records) {
      if (record.identity.workspaceId === workspaceId) this.disposeRecord(key, record, true);
    }
  }

  /** Stops host visibility and disposes every registered surface. */
  public disposeHost(): void {
    this.stopVisibility();
    this.disposeAll();
    this.materializedListeners.clear();
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
    record.adapter?.dispose(remove ? "dispose" : "replace");
    record.adapter = null;
    record.state = null;
    if (remove) record.listeners.clear();
    if (remove && this.records.get(key) === record) this.records.delete(key);
  }

  private reduce(record: SurfaceRecord, event: BrowserSurfaceAdapterEvent): void {
    const previous = record.state;
    if (!previous || event.type === "surface-lost") return;
    const next = this.nextState(previous, event);
    if (next === previous) return;
    record.state = next;
    record.recoveryAddress = next.recoveryAddress;
    record.title = next.title;
    record.favicon = next.favicon;
    record.publicationPending = true;
    this.schedulePublication(record);
  }

  private nextState(state: BrowserSurfacePageState, event: BrowserSurfaceAdapterEvent): BrowserSurfacePageState {
    if (!sameIdentity(state.identity, event.identity) || state.generation !== event.generation) return state;
    return this.nextStateHandlers[event.type](state, event);
  }

  private navigationStartedState(
    state: BrowserSurfacePageState,
    event: Extract<BrowserSurfaceAdapterEvent, { type: "navigation-started" }>,
  ): BrowserSurfacePageState {
    if (!event.mainFrame) return state;
    return this.mergeState(state, { pendingAddress: boundString(event.address, MAX_ADDRESS), phase: "loading", mainFrameError: null, mainFrameErrorCode: null });
  }

  private navigationCommittedState(
    state: BrowserSurfacePageState,
    event: Extract<BrowserSurfaceAdapterEvent, { type: "navigation-committed" }>,
  ): BrowserSurfacePageState {
    if (!event.mainFrame) return state;
    const address = boundString(event.address, MAX_ADDRESS);
    return this.mergeState(state, { committedAddress: address, recoveryAddress: address });
  }

  private loadStartedState(
    state: BrowserSurfacePageState,
    event: Extract<BrowserSurfaceAdapterEvent, { type: "load-started" }>,
  ): BrowserSurfacePageState {
    if (!event.mainFrame) return state;
    return this.mergeState(state, { ...this.pendingAddress(event.address), phase: "loading", mainFrameError: null, mainFrameErrorCode: null });
  }

  private loadFailedState(
    state: BrowserSurfacePageState,
    event: Extract<BrowserSurfaceAdapterEvent, { type: "load-failed" }>,
  ): BrowserSurfacePageState {
    if (!event.mainFrame || eventIsExpectedAbort(event)) return state;
    if (this.failureTargetsAnotherPage(state, event.address)) return state;
    return this.mergeState(state, {
      ...this.pendingAddress(event.address),
      phase: "error",
      mainFrameError: boundString(event.error ?? this.errorCodeText(event.errorCode), 500),
      mainFrameErrorCode: event.errorCode ?? null,
    });
  }

  private loadStoppedState(
    state: BrowserSurfacePageState,
    event: Extract<BrowserSurfaceAdapterEvent, { type: "load-stopped" }>,
  ): BrowserSurfacePageState {
    if (!event.mainFrame || state.phase === "error") return state;
    return this.mergeState(state, { ...this.committedAddress(event.address), pendingAddress: null, phase: "loaded" });
  }

  private pendingAddress(address: string | undefined): Partial<BrowserSurfacePageState> {
    return address === undefined ? {} : { pendingAddress: boundString(address, MAX_ADDRESS) };
  }

  private committedAddress(address: string | undefined): Partial<BrowserSurfacePageState> {
    if (address === undefined) return {};
    const bounded = boundString(address, MAX_ADDRESS);
    return { committedAddress: bounded, recoveryAddress: bounded };
  }

  private failureTargetsAnotherPage(state: BrowserSurfacePageState, address: string | undefined): boolean {
    return address !== undefined && state.committedAddress !== null &&
      address !== state.pendingAddress && address !== state.committedAddress;
  }

  private errorCodeText(errorCode: string | number | undefined): string | undefined {
    return typeof errorCode === "number" ? String(errorCode) : errorCode;
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
    if (!record.state || record.frameHandle !== null || this.visibility.isHidden()) return;
    record.frameHandle = this.scheduling.requestAnimationFrame(() => {
      record.frameHandle = null;
      if (record.disposed || this.visibility.isHidden()) return;
      if (!record.publicationPending) return;
      record.publicationPending = false;
      if (!record.state) return;
      for (const listener of record.listeners) listener(record.state);
    });
  }

  private publishVisibleRecords(): void {
    if (this.visibility.isHidden()) return;
    for (const record of this.records.values()) {
      if (!record.publicationPending) continue;
      this.schedulePublication(record);
    }
  }

  private metadataFor(record: SurfaceRecord): RetainedBrowserSurfaceMetadata {
    return {
      recoveryAddress: record.state?.recoveryAddress ?? record.recoveryAddress,
      title: record.state?.title ?? record.title,
      favicon: record.state?.favicon ?? record.favicon,
    };
  }

  private isProtected(record: SurfaceRecord): boolean {
    return record.visible || record.controlled || record.operationPins > 0 || record.capturePins > 0;
  }

  private retireToCold(record: SurfaceRecord, reason: BrowserSurfaceDisposalReason = "discard"): void {
    const metadata = this.metadataFor(record);
    record.recoveryAddress = metadata.recoveryAddress;
    record.title = metadata.title;
    record.favicon = metadata.favicon;
    record.visible = false;
    record.presentation = null;
    if (record.frameHandle !== null) this.scheduling.cancelAnimationFrame(record.frameHandle);
    record.frameHandle = null;
    record.publicationPending = false;
    record.stopAdapter();
    record.stopAdapter = () => undefined;
    record.adapter?.dispose(reason);
    record.adapter = null;
    record.state = null;
  }

  private rewarmRecord(record: SurfaceRecord, requestedAddress?: string, requestedGeneration?: number): BrowserSurfacePageState {
    const recoveryAddress = requestedAddress ?? record.recoveryAddress ?? undefined;
    return this.create(record.identity, {
      generation: requestedGeneration ?? record.generation + 1,
      ...(recoveryAddress === undefined ? {} : { address: recoveryAddress }),
    });
  }

  private handleUnexpectedLoss(record: SurfaceRecord, requestedGeneration?: number): void {
    const validRequestedGeneration = Number.isSafeInteger(requestedGeneration) && requestedGeneration! > record.generation
      ? requestedGeneration
      : undefined;
    const shouldRestore = validRequestedGeneration !== undefined || this.isProtected(record);
    const presentation = record.presentation;
    this.retireToCold(record, "loss");
    if (!shouldRestore) return;
    this.rewarmRecord(record, undefined, validRequestedGeneration);
    if (presentation) this.present(record.identity, presentation);
  }

  private pin(
    identity: BrowserSurfaceIdentity,
    generation: number,
    field: "operationPins" | "capturePins",
  ): () => void {
    const record = this.records.get(surfaceKey(identity));
    if (!record || !record.state || record.generation !== generation || !sameIdentity(record.identity, identity)) {
      return () => undefined;
    }
    record[field] += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.records.get(surfaceKey(identity));
      if (current !== record) return;
      current[field] = Math.max(0, current[field] - 1);
    };
  }
}

interface SurfaceRecord {
  readonly identity: BrowserSurfaceIdentity;
  readonly generation: number;
  adapter: BrowserSurfaceAdapter | null;
  readonly listeners: Set<BrowserSurfaceListener>;
  state: BrowserSurfacePageState | null;
  recoveryAddress: string | null;
  title: string;
  favicon: string | null;
  stopAdapter: () => void;
  frameHandle: number | null;
  publicationPending: boolean;
  disposed: boolean;
  visible: boolean;
  controlled: boolean;
  operationPins: number;
  capturePins: number;
  presentation: BrowserSurfacePresentation | null;
}
