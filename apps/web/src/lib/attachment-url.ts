import { storedAttachmentSuffix } from "@mcode/contracts";
import { AUTH_TOKEN_STORAGE_KEY } from "@/transport/scan-port-range";

/** Last WebSocket URL used by the transport; drives HTTP attachment URLs in browser builds. */
let transportWsUrl: string | null = null;
const attachmentTransportListeners = new Set<() => void>();

function hasDesktopAttachmentBridge(): boolean {
  return typeof window !== "undefined" && !!window.desktopBridge;
}

function getEffectiveAttachmentTransportUrl(): string | null {
  const e2eWs = readE2EAttachmentTransportWsOverride();
  if (e2eWs) return e2eWs;
  return hasDesktopAttachmentBridge() ? null : transportWsUrl;
}

function notifyAttachmentTransportListeners(previousUrl: string | null): void {
  if (previousUrl === getEffectiveAttachmentTransportUrl()) return;
  for (const listener of attachmentTransportListeners) listener();
}

/**
 * Stores the active WebSocket URL so {@link buildStoredAttachmentImageSrc} can derive
 * the matching `http(s)` origin for `/attachments/` requests (called from ws `onopen`).
 */
export function setAttachmentTransportWsUrl(wsUrl: string): void {
  const previousUrl = getEffectiveAttachmentTransportUrl();
  transportWsUrl = wsUrl;
  notifyAttachmentTransportListeners(previousUrl);
}

/**
 * Returns the last URL passed to {@link setAttachmentTransportWsUrl}, if any.
 */
export function getAttachmentTransportWsUrl(): string | null {
  return transportWsUrl;
}

/** Returns the attachment transport URL that affects the current renderer. */
export function getAttachmentTransportUrlSnapshot(): string | null {
  return getEffectiveAttachmentTransportUrl();
}

/** Subscribes to effective attachment transport URL changes. */
export function subscribeToAttachmentTransportUrl(listener: () => void): () => void {
  attachmentTransportListeners.add(listener);
  return () => attachmentTransportListeners.delete(listener);
}

/**
 * Clears the cached transport URL. Lets unit tests reset state between cases.
 */
export function clearAttachmentTransportWsUrlCache(): void {
  const previousUrl = getEffectiveAttachmentTransportUrl();
  transportWsUrl = null;
  if (typeof window !== "undefined") {
    delete (window as unknown as { __mcodeE2EAttachmentTransportWsUrl?: string })
      .__mcodeE2EAttachmentTransportWsUrl;
  }
  notifyAttachmentTransportListeners(previousUrl);
}

/**
 * Playwright E2E sets `window.__mcodeE2EAttachmentTransportWsUrl` so
 * {@link buildStoredAttachmentImageSrc} can use an HTTP origin before the real WebSocket opens.
 * Read only in the browser; production code never sets this property.
 */
function readE2EAttachmentTransportWsOverride(): string | null {
  if (typeof window === "undefined") return null;
  const v = (window as unknown as { __mcodeE2EAttachmentTransportWsUrl?: unknown })
    .__mcodeE2EAttachmentTransportWsUrl;
  return typeof v === "string" ? v : null;
}

function wsUrlToHttpOrigin(wsUrl: string): string {
  const u = new URL(wsUrl);
  const proto = u.protocol === "wss:" ? "https:" : "http:";
  return `${proto}//${u.host}`;
}

/**
 * Builds a URL for loading a persisted attachment image (thumbnail or lightbox).
 * Playwright can set `window.__mcodeE2EAttachmentTransportWsUrl` so `/attachments/` HTTP is used
 * even when a stray `desktopBridge` stub exists. Otherwise Electron uses `mcode-attachment:` and
 * the standalone web app uses the local HTTP server.
 */
export function buildStoredAttachmentImageSrc(
  threadId: string,
  id: string,
  mimeType: string,
): string {
  const ext = storedAttachmentSuffix(mimeType);
  const filename = `${id}${ext}`;

  const e2eWs = readE2EAttachmentTransportWsOverride();
  if (e2eWs) {
    const base = wsUrlToHttpOrigin(e2eWs);
    const token =
      typeof localStorage !== "undefined" ? localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? "" : "";
    const q = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${base}/attachments/${threadId}/${filename}${q}`;
  }

  if (hasDesktopAttachmentBridge()) {
    return `mcode-attachment://${threadId}/${filename}`;
  }

  const ws = transportWsUrl;
  if (ws) {
    const base = wsUrlToHttpOrigin(ws);
    const token =
      typeof localStorage !== "undefined" ? localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? "" : "";
    const q = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${base}/attachments/${threadId}/${filename}${q}`;
  }
  return `mcode-attachment://${threadId}/${filename}`;
}
