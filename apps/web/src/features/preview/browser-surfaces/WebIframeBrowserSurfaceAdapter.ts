import { BROWSER_TAB_INFO_STRING_MAX } from "@mcode/contracts";
import type {
  BrowserSurfaceAdapter,
  BrowserSurfaceAdapterEvent,
  BrowserSurfaceAdapterEventPayload,
  BrowserSurfaceAdapterFactory,
  BrowserSurfaceIdentity,
  BrowserSurfacePresentation,
} from "./BrowserSurfaceHost";
import { normalizeBrowserSurfaceAddress } from "./browserSurfaceAddress";

/** Options for the web iframe Browser surface adapter factory. */
export interface WebIframeBrowserSurfaceAdapterFactoryOptions {
  readonly root?: HTMLElement | null;
  readonly document?: Document;
  readonly title?: string;
  readonly onLoad?: (identity: BrowserSurfaceIdentity, generation: number) => void;
}

/** Bounds observable iframe metadata without reading cross-origin documents. */
export interface WebIframeBrowserSurfaceObservation {
  readonly address: string | null;
  readonly title: string | null;
  readonly favicon: string | null;
  readonly access: "same-origin" | "cross-origin" | "unknown";
}

const MAX_ADDRESS = BROWSER_TAB_INFO_STRING_MAX.url;
const MAX_TITLE = BROWSER_TAB_INFO_STRING_MAX.title;
const MAX_FAVICON = BROWSER_TAB_INFO_STRING_MAX.faviconUrl;

function bound(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  return String(value).slice(0, max);
}

function sameOriginObservation(frame: HTMLIFrameElement): WebIframeBrowserSurfaceObservation {
  const fallbackAddress = bound(frame.src, MAX_ADDRESS);
  try {
    const sourceOrigin = fallbackAddress
      ? new URL(fallbackAddress, frame.ownerDocument.location.href).origin
      : null;
    if (sourceOrigin && sourceOrigin !== frame.ownerDocument.location.origin) {
      return { address: fallbackAddress, title: null, favicon: null, access: "cross-origin" };
    }
    const observedOrigin = frame.contentWindow?.location.origin;
    if (observedOrigin && observedOrigin !== frame.ownerDocument.location.origin) {
      return { address: fallbackAddress, title: null, favicon: null, access: "cross-origin" };
    }
    const frameDocument = frame.contentDocument;
    if (!frameDocument) {
      return { address: fallbackAddress, title: null, favicon: null, access: "unknown" };
    }
    const address = bound(frameDocument.location?.href || frame.src, MAX_ADDRESS);
    const title = bound(frameDocument.title, MAX_TITLE);
    const icon = frameDocument.querySelector<HTMLLinkElement>(
      'link[rel~="icon"], link[rel="shortcut icon"]',
    )?.href;
    return {
      address,
      title: title || null,
      favicon: bound(icon, MAX_FAVICON),
      access: "same-origin",
    };
  } catch {
    // A cross-origin frame is observable only through the iframe element itself.
    return { address: fallbackAddress, title: null, favicon: null, access: "cross-origin" };
  }
}

/** Adapter that owns one HTMLIFrameElement and reports safe semantic events. */
export class WebIframeBrowserSurfaceAdapter implements BrowserSurfaceAdapter {
  private readonly listeners = new Set<(event: BrowserSurfaceAdapterEvent) => void>();
  private readonly frame: HTMLIFrameElement;
  private readonly documentRef: Document;
  private readonly onLoadObserved?: WebIframeBrowserSurfaceAdapterFactoryOptions["onLoad"];
  private disposed = false;

  /** Creates and mounts an iframe adapter for one identity and generation. */
  public constructor(
    private readonly identity: BrowserSurfaceIdentity,
    private readonly generation: number,
    options: WebIframeBrowserSurfaceAdapterFactoryOptions = {},
  ) {
    this.documentRef = options.document ?? document;
    this.onLoadObserved = options.onLoad;
    this.frame = this.documentRef.createElement("iframe");
    this.frame.title = options.title ?? "Browser surface";
    this.frame.dataset.testid = "web-runtime-preview-iframe";
    this.frame.dataset.workspaceId = identity.workspaceId;
    this.frame.dataset.scopeKind = identity.scope.kind;
    this.frame.dataset.scopeId = identity.scope.id;
    this.frame.dataset.tabId = identity.tabId;
    this.frame.dataset.generation = String(generation);
    if (identity.scope.kind === "thread") this.frame.dataset.threadId = identity.scope.id;
    this.frame.referrerPolicy = "no-referrer";
    this.frame.setAttribute("aria-hidden", "true");
    this.frame.style.position = "fixed";
    this.frame.style.left = "-20000px";
    this.frame.style.top = "0";
    this.frame.style.width = "1px";
    this.frame.style.height = "1px";
    this.frame.style.border = "0";
    this.frame.style.visibility = "hidden";
    this.frame.style.pointerEvents = "none";
    this.frame.addEventListener("load", this.onLoad);
    this.frame.addEventListener("error", this.onError);
    (options.root ?? this.documentRef.body)?.appendChild(this.frame);
  }

  /** Returns the owned iframe for placement assertions and host integration. */
  public get element(): HTMLIFrameElement {
    return this.frame;
  }

  /** Presents the iframe at its existing placement. */
  public present(presentation: BrowserSurfacePresentation = { left: 0, top: 0, width: 1, height: 1 }): void {
    if (this.disposed) return;
    this.frame.style.left = `${presentation.left}px`;
    this.frame.style.top = `${presentation.top}px`;
    this.frame.style.width = `${presentation.width}px`;
    this.frame.style.height = `${presentation.height}px`;
    this.frame.style.transformOrigin = "top left";
    this.frame.style.transform = presentation.scale === undefined ? "" : `scale(${presentation.scale})`;
    this.frame.style.zIndex = presentation.zIndex === undefined ? "" : String(presentation.zIndex);
    this.frame.style.clipPath = presentation.coveredLeft
      ? `inset(0px 0px 0px ${presentation.coveredLeft}px)`
      : "";
    this.frame.style.visibility = "visible";
    this.frame.style.pointerEvents = presentation.inputEnabled === false ? "none" : "auto";
    this.frame.setAttribute("aria-hidden", presentation.accessible === false ? "true" : "false");
  }

  /** Hides the iframe without replacing its document. */
  public hide(): void {
    if (this.disposed) return;
    this.frame.style.visibility = "hidden";
    this.frame.style.pointerEvents = "none";
    this.frame.setAttribute("aria-hidden", "true");
  }

  /** Navigates by assigning a bounded URL to the owned iframe. */
  public navigate(address: string): void {
    if (this.disposed) return;
    const normalized = normalizeBrowserSurfaceAddress(address);
    this.emit({ type: "navigation-started", mainFrame: true, address: normalized });
    this.frame.src = normalized;
  }

  /** Subscribes to semantic adapter events. */
  public subscribe(listener: (event: BrowserSurfaceAdapterEvent) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Removes DOM listeners and releases the owned iframe. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frame.removeEventListener("load", this.onLoad);
    this.frame.removeEventListener("error", this.onError);
    this.listeners.clear();
    this.frame.remove();
  }

  private emit(event: BrowserSurfaceAdapterEventPayload): void {
    if (this.disposed) return;
    const complete = { ...event, identity: this.identity, generation: this.generation } as BrowserSurfaceAdapterEvent;
    for (const listener of [...this.listeners]) listener(complete);
  }

  private readonly onLoad = (): void => {
    if (this.disposed) return;
    this.onLoadObserved?.(this.identity, this.generation);
    const observation = sameOriginObservation(this.frame);
    if (observation.address) {
      this.emit({ type: "navigation-committed", mainFrame: true, address: observation.address });
    }
    this.emit({ type: "load-stopped", mainFrame: true, address: observation.address ?? undefined });
    this.emit({ type: "title-updated", title: observation.title });
    this.emit({ type: "favicon-updated", favicon: observation.favicon });
    this.emit({ type: "navigation-state", navigation: null });
    this.emit({ type: "document-access", access: observation.access });
  };

  private readonly onError = (): void => {
    if (this.disposed) return;
    this.emit({
      type: "load-failed",
      mainFrame: true,
      address: bound(this.frame.src, MAX_ADDRESS) ?? undefined,
      error: "Iframe navigation failed",
    });
  };
}

/** Creates an adapter factory that mounts one iframe per identity and generation. */
export function createWebIframeBrowserSurfaceAdapterFactory(
  options: WebIframeBrowserSurfaceAdapterFactoryOptions = {},
): BrowserSurfaceAdapterFactory {
  return (identity, generation) => new WebIframeBrowserSurfaceAdapter(identity, generation, options);
}

/** Alias retained for callers that use the shorter iframe adapter name. */
export const createIframeBrowserSurfaceAdapterFactory = createWebIframeBrowserSurfaceAdapterFactory;

/** Alias for integrations that refer to the adapter by its surface role. */
export const createWebIframeSurfaceAdapterFactory = createWebIframeBrowserSurfaceAdapterFactory;
