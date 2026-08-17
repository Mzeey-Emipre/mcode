import type {
  BrowserSurfaceHost,
  BrowserSurfaceIdentity,
  BrowserSurfacePageState,
  BrowserSurfacePresentation,
} from "../browser-surfaces";

/** Identifies the renderer path that requested Browser surface presentation. */
export type BrowserSurfacePresentationSource = "panel" | "automation";

/** A bounded rectangle supplied by a renderer anchor. */
export interface BrowserSurfacePresentationRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Intent published by a Browser panel or an automation surface. */
export interface BrowserSurfacePresentationIntent {
  readonly source: BrowserSurfacePresentationSource;
  readonly active: boolean;
  readonly anchor?: HTMLElement | BrowserSurfacePresentationRect | null;
  readonly pageState?: BrowserSurfacePageState | null;
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Optional explicit overlap used by focused renderer tests and callers. */
  readonly coveredLeft?: number;
  /** Explicitly controls input for a visible detached surface. */
  readonly inputEnabled?: boolean;
  /** Explicitly controls accessibility exposure for a visible detached surface. */
  readonly accessible?: boolean;
}

/** Token and cleanup handle for one identity-bound presentation registration. */
export interface BrowserSurfacePresentationRegistration {
  readonly token: symbol;
  readonly release: () => void;
}

interface AnchorRegistration {
  readonly token: symbol;
  readonly element: HTMLElement;
  visible: boolean;
  stopResize: (() => void) | null;
}

interface PresentationRegistration {
  readonly source: BrowserSurfacePresentationSource;
  intent: BrowserSurfacePresentationIntent;
}

interface SurfaceIntents {
  readonly identity: BrowserSurfaceIdentity;
  readonly intents: Partial<Record<BrowserSurfacePresentationSource, BrowserSurfacePresentationIntent>>;
  readonly registrations: Map<symbol, PresentationRegistration>;
}

function createSurfaceIntents(identity: BrowserSurfaceIdentity): SurfaceIntents {
  return { identity, intents: {}, registrations: new Map() };
}

const OFFSCREEN_AUTOMATION_RECT: BrowserSurfacePresentationRect = {
  left: -20_000,
  top: 0,
  width: 1_280,
  height: 720,
};

function identityKey(identity: BrowserSurfaceIdentity): string {
  return JSON.stringify([identity.workspaceId, identity.scope.kind, identity.scope.id, identity.tabId]);
}

function scopeKey(workspaceId: string, threadId: string): string {
  return JSON.stringify([workspaceId, threadId]);
}

function asRect(anchor: HTMLElement | BrowserSurfacePresentationRect): BrowserSurfacePresentationRect {
  if (typeof HTMLElement !== "undefined" && anchor instanceof HTMLElement) {
    const bounds = anchor.getBoundingClientRect();
    return {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    };
  }
  return anchor as BrowserSurfacePresentationRect;
}

function hasGeometry(rect: BrowserSurfacePresentationRect | null): rect is BrowserSurfacePresentationRect {
  return rect !== null && rect.width > 0 && rect.height > 0;
}

function isPresentablePage(pageState: BrowserSurfacePageState | null | undefined): boolean {
  if (!pageState) return true;
  if (pageState.phase === "error") return false;
  const address = pageState.committedAddress ?? pageState.pendingAddress;
  return Boolean(address) &&
    !address!.startsWith("about:") &&
    !address!.startsWith("chrome-error:");
}

function boundedCoveredLeft(overlap: number, width: number, scale: number): number {
  if (!Number.isFinite(overlap) || !Number.isFinite(scale) || scale <= 0) return 0;
  return Math.min(width, Math.max(0, overlap / scale));
}

/**
 * Resolves panel and automation presentation intent before it reaches the
 * persistent BrowserSurfaceHost. The coordinator owns every present/hide call.
 */
export class BrowserSurfacePresentationCoordinator {
  private readonly records = new Map<string, SurfaceIntents>();
  private readonly automationAnchors = new Map<string, Map<symbol, AnchorRegistration>>();
  private readonly listeners = new Set<() => void>();
  private activityRailOverlap = 0;

  /** Creates a coordinator for one renderer-window BrowserSurfaceHost. */
  public constructor(private readonly host: BrowserSurfaceHost) {}

  /** Publishes or replaces one source's presentation intent. */
  public publish(
    identity: BrowserSurfaceIdentity,
    intent: BrowserSurfacePresentationIntent,
    registrationToken?: symbol,
  ): () => void {
    const key = identityKey(identity);
    const record = this.records.get(key) ?? createSurfaceIntents(identity);
    if (registrationToken) {
      if (!record.registrations.has(registrationToken)) return () => undefined;
      record.registrations.get(registrationToken)!.intent = intent;
    } else {
      record.intents[intent.source] = intent;
    }
    this.records.set(key, record);
    this.apply(record);
    this.notify();
    return () => {
      if (registrationToken) {
        this.releaseRegistration(identity, registrationToken);
        return;
      }
      const current = this.records.get(key);
      if (current?.intents[intent.source] !== intent) return;
      delete current.intents[intent.source];
      this.apply(current);
      if (!current.intents.panel && !current.intents.automation && current.registrations.size === 0) this.records.delete(key);
      this.notify();
    };
  }

  /** Removes one source intent and hides the surface when no source remains. */
  public clear(identity: BrowserSurfaceIdentity, source: BrowserSurfacePresentationSource, registrationToken?: symbol): void {
    const key = identityKey(identity);
    const record = this.records.get(key);
    if (!record) return;
    if (registrationToken) {
      this.releaseRegistration(identity, registrationToken);
      return;
    }
    delete record.intents[source];
    for (const [token, registration] of record.registrations) {
      if (registration.source === source) record.registrations.delete(token);
    }
    this.apply(record);
    if (!record.intents.panel && !record.intents.automation && record.registrations.size === 0) this.records.delete(key);
    this.notify();
  }

  /** Registers a panel or automation anchor with a unique cleanup token. */
  public registerAnchor(
    identity: BrowserSurfaceIdentity,
    source: BrowserSurfacePresentationSource,
    element: HTMLElement,
  ): BrowserSurfacePresentationRegistration {
    const key = identityKey(identity);
    const record = this.records.get(key) ?? createSurfaceIntents(identity);
    const token = Symbol(`browser-${source}-anchor`);
    record.registrations.set(token, {
      source,
      intent: { source, active: false, anchor: element },
    });
    this.records.set(key, record);
    this.apply(record);
    this.notify();
    return { token, release: () => this.releaseRegistration(identity, token) };
  }

  /** Registers one automation dock anchor. Multiple registrations may share a scope. */
  public registerAutomationAnchor(
    workspaceId: string,
    threadId: string,
    element: HTMLElement | null,
    visible = true,
  ): () => void {
    const key = scopeKey(workspaceId, threadId);
    if (!element) {
      this.reapplyScope(workspaceId, threadId);
      this.notify();
      return () => undefined;
    }
    const token = Symbol("browser-automation-anchor");
    const registration: AnchorRegistration = { token, element, visible, stopResize: null };
    const registrations = this.automationAnchors.get(key) ?? new Map<symbol, AnchorRegistration>();
    registrations.set(token, registration);
    this.automationAnchors.set(key, registrations);
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => {
        this.reapplyScope(workspaceId, threadId);
        this.notify();
      });
      observer.observe(element);
      registration.stopResize = () => observer.disconnect();
    }
    this.reapplyScope(workspaceId, threadId);
    this.notify();
    return () => {
      const current = this.automationAnchors.get(key);
      if (!current?.has(token)) return;
      current.get(token)?.stopResize?.();
      current.delete(token);
      if (current.size === 0) this.automationAnchors.delete(key);
      this.reapplyScope(workspaceId, threadId);
      this.notify();
    };
  }

  /** Updates one registered dock visibility without reading DOM state. */
  public setAutomationAnchorVisibility(workspaceId: string, threadId: string, visible: boolean): void {
    const registrations = this.automationAnchors.get(scopeKey(workspaceId, threadId));
    if (!registrations) return;
    let changed = false;
    for (const registration of registrations.values()) {
      if (registration.visible === visible) continue;
      registration.visible = visible;
      changed = true;
    }
    if (!changed) return;
    this.reapplyScope(workspaceId, threadId);
    this.notify();
  }

  /** Returns the first visible automation dock rectangle for layout consumers. */
  public getAutomationAnchorRect(workspaceId: string, threadId: string): BrowserSurfacePresentationRect | null {
    const registrations = this.automationAnchors.get(scopeKey(workspaceId, threadId));
    if (!registrations) return null;
    for (const registration of registrations.values()) {
      if (!registration.visible) continue;
      const rect = asRect(registration.element);
      if (hasGeometry(rect)) return rect;
    }
    return null;
  }

  /** Returns true when a dock anchor is registered for an automation scope. */
  public hasAutomationAnchor(workspaceId: string, threadId: string): boolean {
    return [...(this.automationAnchors.get(scopeKey(workspaceId, threadId))?.values() ?? [])]
      .some((registration) => registration.visible);
  }

  /** Subscribes to anchor and intent changes. */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sets the explicit Activity Rail overlap applied to panel and dock anchors. */
  public setActivityRailOverlap(overlap: number): void {
    const next = Number.isFinite(overlap) ? Math.max(0, overlap) : 0;
    if (next === this.activityRailOverlap) return;
    this.activityRailOverlap = next;
    for (const record of this.records.values()) this.apply(record);
    this.notify();
  }

  /** Returns the currently configured Activity Rail overlap. */
  public getActivityRailOverlap(): number {
    return this.activityRailOverlap;
  }

  /** Hides every coordinated surface and releases coordinator-owned state. */
  public dispose(): void {
    for (const record of this.records.values()) this.host.hide(record.identity);
    for (const registrations of this.automationAnchors.values()) {
      for (const registration of registrations.values()) registration.stopResize?.();
    }
    this.records.clear();
    this.automationAnchors.clear();
    this.notify();
  }

  private readonly apply = (record: SurfaceIntents): void => {
    const panel = this.effectiveIntent(record, "panel");
    const automation = this.effectiveIntent(record, "automation");
    const panelRect = panel?.active ? this.panelRect(panel) : null;
    const panelVisible = panel?.active === true && hasGeometry(panelRect);
    const automationRect = automation?.active ? this.automationRect(record.identity) : null;
    const automationVisible = automation?.active === true && hasGeometry(automationRect);
    const intent = panelVisible
      ? panel
      : automationVisible || automation?.active === true
        ? automation
        : null;
    if (!intent) {
      this.host.hide(record.identity);
      return;
    }
    const rect = intent.source === "panel"
      ? panelRect
      : automationVisible
        ? automationRect
        : OFFSCREEN_AUTOMATION_RECT;
    if (!rect || !isPresentablePage(intent.pageState)) {
      this.host.hide(record.identity);
      return;
    }
    const intrinsicWidth = intent.viewport?.width ?? rect.width;
    const intrinsicHeight = intent.viewport?.height ?? rect.height;
    const scale = intent.viewport
      ? Math.min(rect.width / intrinsicWidth, rect.height / intrinsicHeight)
      : 1;
    const offscreen = intent.source === "automation" && !automationVisible;
    const presentation: BrowserSurfacePresentation = {
      left: rect.left,
      top: rect.top,
      width: intrinsicWidth,
      height: intrinsicHeight,
      scale,
      zIndex: offscreen ? 29 : 31,
      coveredLeft: offscreen
        ? 0
        : boundedCoveredLeft(intent.coveredLeft ?? this.activityRailOverlap, rect.width, scale),
      inputEnabled: offscreen ? false : intent.inputEnabled ?? intent.source === "panel",
      accessible: offscreen ? false : intent.accessible ?? intent.source === "panel",
    };
    this.host.present(record.identity, presentation);
  };

  private panelRect(intent: BrowserSurfacePresentationIntent): BrowserSurfacePresentationRect | null {
    if (!intent.anchor) return null;
    return asRect(intent.anchor);
  }

  private automationRect(identity: BrowserSurfaceIdentity): BrowserSurfacePresentationRect | null {
    if (identity.scope.kind !== "thread") return null;
    return this.getAutomationAnchorRect(identity.workspaceId, identity.scope.id);
  }

  private reapplyScope(workspaceId: string, threadId: string): void {
    for (const record of this.records.values()) {
      if (record.identity.workspaceId !== workspaceId || record.identity.scope.kind !== "thread" || record.identity.scope.id !== threadId) continue;
      this.apply(record);
    }
  }

  private effectiveIntent(
    record: SurfaceIntents,
    source: BrowserSurfacePresentationSource,
  ): BrowserSurfacePresentationIntent | undefined {
    let latest: BrowserSurfacePresentationIntent | undefined;
    let active: BrowserSurfacePresentationIntent | undefined;
    for (const registration of record.registrations.values()) {
      if (registration.source !== source) continue;
      latest = registration.intent;
      if (registration.intent.active) active = registration.intent;
    }
    return active ?? latest ?? record.intents[source];
  }

  private releaseRegistration(identity: BrowserSurfaceIdentity, token: symbol): void {
    const key = identityKey(identity);
    const record = this.records.get(key);
    if (!record?.registrations.delete(token)) return;
    this.apply(record);
    if (!record.intents.panel && !record.intents.automation && record.registrations.size === 0) {
      this.records.delete(key);
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
