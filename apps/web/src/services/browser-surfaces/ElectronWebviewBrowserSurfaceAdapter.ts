import { BROWSER_TAB_INFO_STRING_MAX } from "@mcode/contracts";
import type {
  PreviewSurfaceBridge,
  PreviewSurfaceBridgeResult,
  PreviewSurfaceNavigation,
  PreviewSurfaceRef,
} from "@/transport/desktop-bridge";
import type {
  BrowserSurfaceAdapter,
  BrowserSurfaceAdapterEvent,
  BrowserSurfaceAdapterEventPayload,
  BrowserSurfaceAdapterFactory,
  BrowserSurfaceDisposalReason,
  BrowserSurfaceIdentity,
  BrowserSurfacePresentation,
} from "./BrowserSurfaceHost";

const MAX_ADDRESS = BROWSER_TAB_INFO_STRING_MAX.url;
const MAX_TITLE = BROWSER_TAB_INFO_STRING_MAX.title;
const MAX_FAVICON = BROWSER_TAB_INFO_STRING_MAX.faviconUrl;
const INERT_URL_PREFIX = "about:blank#";

/** Options for the renderer-owned Electron webview Browser surface adapter. */
export interface ElectronWebviewBrowserSurfaceAdapterOptions {
  readonly root?: HTMLElement | null;
  readonly document?: Document;
  readonly bridge?: PreviewSurfaceBridge;
  readonly title?: string;
  readonly onHumanInput?: (identity: BrowserSurfaceIdentity, generation: number) => void;
}

interface ElectronWebviewElement extends HTMLElement {
  src: string;
  referrerPolicy: string;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

type WebviewEvent = Event & {
  readonly isMainFrame?: boolean;
  readonly url?: unknown;
  readonly validatedURL?: unknown;
  readonly title?: unknown;
  readonly favicons?: unknown;
  readonly errorCode?: unknown;
  readonly errorDescription?: unknown;
  readonly channel?: unknown;
  readonly args?: readonly unknown[];
};

const PREVIEW_GUEST_HUMAN_INPUT_CHANNEL = "mcode:browser-human-input";
const HUMAN_INPUT_KINDS = new Set(["keyboard", "pointer", "touch", "wheel"]);
const ADOPTION_DISCOVERY_ATTEMPTS = 40;
const ADOPTION_DISCOVERY_RETRY_MS = 50;

/** Validates an absolute address that Electron main will authorize again before loading. */
export function normalizeElectronWebviewSurfaceAddress(address: string): string {
  if (address.length > MAX_ADDRESS) throw new TypeError("Browser surface address exceeds the maximum length");
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new TypeError("Browser surface address must be an absolute URL");
  }
  if (!["http:", "https:", "file:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError("Electron Browser surface address must use HTTP(S) or file without credentials");
  }
  return parsed.href;
}

function opaqueToken(): string {
  const cryptoRef = globalThis.crypto;
  if (typeof cryptoRef?.randomUUID === "function") return cryptoRef.randomUUID();
  if (typeof cryptoRef?.getRandomValues !== "function") {
    throw new Error("Secure randomness is required for Browser surface adoption");
  }
  const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function surfaceRef(identity: BrowserSurfaceIdentity, generation: number): PreviewSurfaceRef {
  return { identity, generation };
}

function bounded(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

function eventAddress(event: WebviewEvent): string | null {
  return bounded(event.url, MAX_ADDRESS) ?? bounded(event.validatedURL, MAX_ADDRESS);
}

function mainFrame(event: WebviewEvent): boolean {
  return event.isMainFrame !== false;
}

function bridgeFromWindow(): PreviewSurfaceBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.desktopBridge?.preview?.surface;
}

function asResult(result: PreviewSurfaceBridgeResult | undefined): boolean {
  return result?.ok === true;
}

/** Adapter that owns one Electron `<webview>` and emits generation-bound semantic events. */
export class ElectronWebviewBrowserSurfaceAdapter implements BrowserSurfaceAdapter {
  private readonly listeners = new Set<(event: BrowserSurfaceAdapterEvent) => void>();
  private readonly documentRef: Document;
  private readonly bridge: PreviewSurfaceBridge;
  private readonly surface: PreviewSurfaceRef;
  private readonly adoptionToken: string;
  private readonly preparePromise: Promise<PreviewSurfaceBridgeResult>;
  private adoptionPromise: Promise<boolean> | null = null;
  private readonly adoptionWaiters = new Set<(adopted: boolean) => void>();
  private pendingAddress: string | null = null;
  private adopted = false;
  private disposed = false;
  private readonly frame: ElectronWebviewElement;
  private readonly onHumanInput?: ElectronWebviewBrowserSurfaceAdapterOptions["onHumanInput"];

  /** Creates and mounts a blank Electron webview for one identity and generation. */
  public constructor(
    private readonly identity: BrowserSurfaceIdentity,
    private readonly generation: number,
    options: ElectronWebviewBrowserSurfaceAdapterOptions = {},
  ) {
    this.documentRef = options.document ?? document;
    this.bridge = options.bridge ?? bridgeFromWindow() ?? (() => {
      throw new Error("Electron Browser surface bridge is unavailable");
    })();
    this.onHumanInput = options.onHumanInput;
    this.surface = surfaceRef(identity, generation);
    this.adoptionToken = opaqueToken();
    this.frame = this.documentRef.createElement("webview") as ElectronWebviewElement;
    this.frame.src = `${INERT_URL_PREFIX}${this.adoptionToken}`;
    this.frame.setAttribute("src", this.frame.src);
    this.frame.title = options.title ?? "Browser surface";
    this.frame.setAttribute("partition", "persist:mcode-preview");
    this.frame.setAttribute("allowpopups", "");
    this.frame.setAttribute("aria-hidden", "true");
    this.frame.dataset.testid = "electron-browser-surface-webview";
    this.frame.dataset.workspaceId = identity.workspaceId;
    this.frame.dataset.scopeKind = identity.scope.kind;
    this.frame.dataset.scopeId = identity.scope.id;
    this.frame.dataset.tabId = identity.tabId;
    this.frame.dataset.generation = String(generation);
    this.frame.referrerPolicy = "no-referrer";
    this.frame.style.position = "fixed";
    this.frame.style.left = "-20000px";
    this.frame.style.top = "0";
    this.frame.style.width = "1px";
    this.frame.style.height = "1px";
    this.frame.style.border = "0";
    this.frame.style.visibility = "hidden";
    this.frame.style.pointerEvents = "none";
    this.frame.addEventListener("did-attach", this.onDidAttach);
    this.frame.addEventListener("did-start-loading", this.onLoadStarted);
    this.frame.addEventListener("did-stop-loading", this.onLoadStopped);
    this.frame.addEventListener("did-navigate", this.onNavigated);
    this.frame.addEventListener("did-navigate-in-page", this.onNavigated);
    this.frame.addEventListener("did-fail-load", this.onLoadFailed);
    this.frame.addEventListener("page-title-updated", this.onTitleUpdated);
    this.frame.addEventListener("page-favicon-updated", this.onFaviconUpdated);
    this.frame.addEventListener("dom-ready", this.onDomReady);
    this.frame.addEventListener("ipc-message", this.onIpcMessage);
    this.frame.addEventListener("render-process-gone", this.onRenderProcessGone);
    this.preparePromise = Promise.resolve(this.bridge.prepare({
      surface: this.surface,
      adoptionToken: this.adoptionToken,
    })).catch(() => ({ ok: false as const, error: "Surface preparation failed" }));
    (options.root ?? this.documentRef.body)?.appendChild(this.frame);
  }

  /** Returns the owned webview for host placement and lifecycle integration. */
  public get element(): ElectronWebviewElement {
    return this.frame;
  }

  /** Materializes this adapter; construction already owns and attaches its webview. */
  public create(): void {
    if (this.disposed) return;
    void this.preparePromise.then((result) => {
      if (
        !result.ok &&
        result.error === "stale-generation" &&
        Number.isSafeInteger(result.nextGeneration) &&
        result.nextGeneration! > this.generation
      ) {
        this.emit({ type: "surface-lost", nextGeneration: result.nextGeneration });
      }
    });
  }

  /** Presents the webview at bounded host coordinates. */
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
    this.frame.style.pointerEvents = "auto";
    this.frame.setAttribute("aria-hidden", "false");
  }

  /** Hides the webview without changing its guest document. */
  public hide(): void {
    if (this.disposed) return;
    this.frame.style.visibility = "hidden";
    this.frame.style.pointerEvents = "none";
    this.frame.setAttribute("aria-hidden", "true");
  }

  /** Requests main-process navigation after trusted adoption. */
  public async navigate(address: string): Promise<void> {
    if (this.disposed) return;
    const normalized = normalizeElectronWebviewSurfaceAddress(address);
    this.emit({ type: "navigation-started", mainFrame: true, address: normalized });
    if (!this.adopted) {
      this.pendingAddress = normalized;
      await this.waitForAdoption();
      return;
    }
    await this.sendNavigation(normalized);
  }

  /** Subscribes to semantic adapter events. */
  public subscribe(listener: (event: BrowserSurfaceAdapterEvent) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Removes native listeners, releases the exact surface generation, and detaches the webview. */
  public dispose(reason: BrowserSurfaceDisposalReason = "dispose"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resolveAdoptionWaiters(false);
    this.frame.removeEventListener("did-attach", this.onDidAttach);
    this.frame.removeEventListener("did-start-loading", this.onLoadStarted);
    this.frame.removeEventListener("did-stop-loading", this.onLoadStopped);
    this.frame.removeEventListener("did-navigate", this.onNavigated);
    this.frame.removeEventListener("did-navigate-in-page", this.onNavigated);
    this.frame.removeEventListener("did-fail-load", this.onLoadFailed);
    this.frame.removeEventListener("page-title-updated", this.onTitleUpdated);
    this.frame.removeEventListener("page-favicon-updated", this.onFaviconUpdated);
    this.frame.removeEventListener("dom-ready", this.onDomReady);
    this.frame.removeEventListener("ipc-message", this.onIpcMessage);
    this.frame.removeEventListener("render-process-gone", this.onRenderProcessGone);
    this.listeners.clear();
    void Promise.resolve(this.bridge.release({ surface: this.surface, reason })).catch(() => undefined);
    this.frame.remove();
  }

  private waitForAdoption(): Promise<boolean> {
    if (this.adopted) return Promise.resolve(true);
    return new Promise((resolve) => this.adoptionWaiters.add(resolve));
  }

  private resolveAdoptionWaiters(adopted: boolean): void {
    for (const resolve of this.adoptionWaiters) resolve(adopted);
    this.adoptionWaiters.clear();
  }

  private readonly onDidAttach = (): void => {
    if (this.disposed || this.adoptionPromise) return;
    this.adoptionPromise = this.adoptAfterPreparation();
  };

  private async adoptAfterPreparation(): Promise<boolean> {
    if (!asResult(await this.preparePromise) || this.disposed) {
      this.resolveAdoptionWaiters(false);
      return false;
    }
    let result: PreviewSurfaceBridgeResult = {
      ok: false,
      error: "Surface adoption failed",
    };
    for (let attempt = 0; attempt < ADOPTION_DISCOVERY_ATTEMPTS; attempt += 1) {
      result = await Promise.resolve(this.bridge.adopt({
        surface: this.surface,
        adoptionToken: this.adoptionToken,
      })).catch(() => ({ ok: false as const, error: "Surface adoption failed" }));
      if (result.ok || result.error !== "guest-not-found" || this.disposed) break;
      await new Promise((resolve) => window.setTimeout(resolve, ADOPTION_DISCOVERY_RETRY_MS));
    }
    if (!asResult(result) || this.disposed) {
      this.resolveAdoptionWaiters(false);
      return false;
    }
    this.adopted = true;
    const pendingAddress = this.pendingAddress;
    this.pendingAddress = null;
    if (pendingAddress) await this.sendNavigation(pendingAddress);
    this.resolveAdoptionWaiters(true);
    return true;
  }

  private async sendNavigation(address: string): Promise<void> {
    const navigation: PreviewSurfaceNavigation = { kind: "address", address };
    const result = await Promise.resolve(this.bridge.navigate({
      surface: this.surface,
      navigation,
    })).catch(() => ({ ok: false as const, error: "Navigation failed" }));
    if (!asResult(result)) {
      this.emit({
        type: "load-failed",
        mainFrame: true,
        address,
        error: result.ok ? undefined : result.error,
      });
    }
  }

  private emit(event: BrowserSurfaceAdapterEventPayload): void {
    if (this.disposed) return;
    const complete = { ...event, identity: this.identity, generation: this.generation } as BrowserSurfaceAdapterEvent;
    for (const listener of [...this.listeners]) listener(complete);
  }

  private readonly onLoadStarted = (event: Event): void => {
    const typed = event as WebviewEvent;
    this.emit({ type: "load-started", mainFrame: mainFrame(typed), address: eventAddress(typed) ?? undefined });
  };

  private readonly onLoadStopped = (event: Event): void => {
    const typed = event as WebviewEvent;
    this.emit({ type: "load-stopped", mainFrame: mainFrame(typed), address: eventAddress(typed) ?? undefined });
  };

  private readonly onNavigated = (event: Event): void => {
    const typed = event as WebviewEvent;
    const address = eventAddress(typed);
    if (!address) return;
    this.emit({ type: "navigation-committed", mainFrame: mainFrame(typed), address });
    this.emitNavigationState();
    if (address.startsWith("about:") || address.startsWith("chrome-error:")) {
      this.emit({ type: "title-updated", title: null });
      this.emit({ type: "favicon-updated", favicon: null });
    }
  };

  private readonly onLoadFailed = (event: Event): void => {
    const typed = event as WebviewEvent;
    const errorCode = typeof typed.errorCode === "string" || typeof typed.errorCode === "number"
      ? typed.errorCode
      : undefined;
    this.emit({
      type: "load-failed",
      mainFrame: mainFrame(typed),
      address: eventAddress(typed) ?? undefined,
      error: bounded(typed.errorDescription, 500) ?? undefined,
      ...(errorCode === undefined ? {} : { errorCode }),
      expected: errorCode === -3 || errorCode === "ERR_ABORTED",
    });
  };

  private readonly onTitleUpdated = (event: Event): void => {
    const title = bounded((event as WebviewEvent).title, MAX_TITLE);
    this.emit({ type: "title-updated", title });
  };

  private readonly onFaviconUpdated = (event: Event): void => {
    const favicons = (event as WebviewEvent).favicons;
    const favicon = Array.isArray(favicons) ? bounded(favicons[0], MAX_FAVICON) : null;
    this.emit({ type: "favicon-updated", favicon });
  };

  private readonly onDomReady = (): void => {
    this.emit({ type: "document-access", access: "unknown" });
    this.emitNavigationState();
  };

  private emitNavigationState(): void {
    this.emit({
      type: "navigation-state",
      navigation: {
        canGoBack: this.frame.canGoBack(),
        canGoForward: this.frame.canGoForward(),
      },
    });
  }

  private readonly onIpcMessage = (event: Event): void => {
    const typed = event as WebviewEvent;
    if (typed.channel !== PREVIEW_GUEST_HUMAN_INPUT_CHANNEL) return;
    const message = typed.args?.[0];
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const kind = (message as { readonly kind?: unknown }).kind;
    if (typeof kind !== "string" || !HUMAN_INPUT_KINDS.has(kind)) return;
    this.onHumanInput?.(this.identity, this.generation);
  };

  private readonly onRenderProcessGone = (): void => {
    this.emit({ type: "surface-lost" });
  };
}

/** Options that create one Electron webview adapter per complete identity and generation. */
export type ElectronWebviewBrowserSurfaceAdapterFactoryOptions = ElectronWebviewBrowserSurfaceAdapterOptions;

/** Creates an Electron webview adapter factory for a renderer surface root. */
export function createElectronWebviewBrowserSurfaceAdapterFactory(
  options: ElectronWebviewBrowserSurfaceAdapterFactoryOptions = {},
): BrowserSurfaceAdapterFactory {
  return (identity, generation) => new ElectronWebviewBrowserSurfaceAdapter(identity, generation, options);
}

/** Alias for integrations that use the shorter Electron surface adapter name. */
export const createElectronWebviewSurfaceAdapterFactory = createElectronWebviewBrowserSurfaceAdapterFactory;
