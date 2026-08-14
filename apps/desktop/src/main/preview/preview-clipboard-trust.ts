import type { IpcMain, IpcMainEvent, Session, WebContents } from "electron";
import { PREVIEW_GUEST_CLIPBOARD_TRUST_CHANNEL } from "../../features/preview/contracts/guest-input.js";

const TRUST_LIFETIME_MS = 5_000;

interface ClipboardGuestState {
  readonly webContents: WebContents;
  readonly guestGeneration: number;
  readonly isCurrentSurface: () => boolean;
  documentGeneration: number;
  grant: ClipboardGrant | null;
  dispose: () => void;
}

interface ClipboardGrant {
  readonly guestGeneration: number;
  readonly documentGeneration: number;
  readonly documentUrl: string;
  readonly expiresAt: number;
}

interface ClipboardPermissionContext {
  readonly isMainFrame: boolean;
  readonly requestingOrigin?: string;
  readonly requestingUrl?: string;
}

const guests = new Map<number, ClipboardGuestState>();
let nextGuestGeneration = 0;

function documentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function origin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function contextMatchesDocument(
  context: ClipboardPermissionContext,
  currentDocumentUrl: string,
): boolean {
  if (!context.isMainFrame) return false;
  if (context.requestingUrl !== undefined) {
    return documentUrl(context.requestingUrl) === currentDocumentUrl;
  }
  if (context.requestingOrigin !== undefined) {
    const currentOrigin = origin(currentDocumentUrl);
    return currentOrigin !== null && origin(context.requestingOrigin) === currentOrigin;
  }
  return false;
}

function grantIsValid(
  state: ClipboardGuestState,
  webContents: WebContents,
  grant: ClipboardGrant | null,
  context: ClipboardPermissionContext,
): grant is ClipboardGrant {
  if (!grant || !state.isCurrentSurface()) return false;
  if (grant.expiresAt < Date.now()) return false;
  if (
    grant.guestGeneration !== state.guestGeneration ||
    grant.documentGeneration !== state.documentGeneration
  ) return false;
  const currentDocumentUrl = documentUrl(webContents.getURL());
  if (!currentDocumentUrl || currentDocumentUrl !== grant.documentUrl) return false;
  return contextMatchesDocument(context, currentDocumentUrl);
}

function consumeClipboardGrant(
  webContents: WebContents | null,
  permission: string,
  context: ClipboardPermissionContext,
): boolean {
  if (!webContents) return false;
  const state = guests.get(webContents.id);
  if (!state || state.webContents !== webContents || webContents.isDestroyed()) return false;
  if (permission !== "clipboard-sanitized-write") {
    state.grant = null;
    return false;
  }
  const grant = state.grant;
  state.grant = null;
  return grantIsValid(state, webContents, grant, context);
}

/** Registers the shared fail-closed permission policy for the Preview partition. */
export function registerPreviewClipboardPermissionHandlers(
  previewPartition: Session,
  clipboardIpc: Pick<IpcMain, "on">,
): void {
  previewPartition.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      consumeClipboardGrant(webContents, permission, {
        isMainFrame: details.isMainFrame,
        requestingOrigin,
        ...(details.requestingUrl ? { requestingUrl: details.requestingUrl } : {}),
      }),
  );
  previewPartition.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        consumeClipboardGrant(webContents, permission, {
          isMainFrame: details.isMainFrame,
          requestingUrl: details.requestingUrl,
        }),
      );
    },
  );
  clipboardIpc.on(
    PREVIEW_GUEST_CLIPBOARD_TRUST_CHANNEL,
    (event: IpcMainEvent) => {
      if (event.senderFrame !== event.sender.mainFrame) return;
      recordTrustedPreviewClipboardClick(event.sender);
    },
  );
}

/** Tracks one Preview guest and its current main-frame document generation. */
export function registerPreviewClipboardGuest(
  webContents: WebContents,
  isCurrentSurface: () => boolean,
): () => void {
  unregisterPreviewClipboardGuest(webContents);
  const guestGeneration = ++nextGuestGeneration;
  const state: ClipboardGuestState = {
    webContents,
    guestGeneration,
    isCurrentSurface,
    documentGeneration: 0,
    grant: null,
    dispose: () => undefined,
  };
  const onNavigation = (
    _event: unknown,
    _url: string,
    isSameDocument: boolean,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame || isSameDocument) return;
    state.documentGeneration += 1;
    state.grant = null;
  };
  const onDestroyed = () => unregisterPreviewClipboardGuest(webContents);
  webContents.on("did-start-navigation", onNavigation);
  webContents.once("destroyed", onDestroyed);
  state.dispose = () => {
    state.grant = null;
    try {
      webContents.removeListener("did-start-navigation", onNavigation);
      webContents.removeListener("destroyed", onDestroyed);
    } catch {
      // Electron can destroy the guest before host cleanup runs.
    }
  };
  guests.set(webContents.id, state);
  return () => unregisterPreviewClipboardGuest(webContents);
}

/** Arms one clipboard write after the fixed preload reports a trusted main-frame click. */
export function recordTrustedPreviewClipboardClick(webContents: WebContents): boolean {
  const state = guests.get(webContents.id);
  if (
    !state ||
    state.webContents !== webContents ||
    webContents.isDestroyed() ||
    !state.isCurrentSurface()
  ) return false;
  const currentDocumentUrl = documentUrl(webContents.getURL());
  if (!currentDocumentUrl) return false;
  state.grant = {
    guestGeneration: state.guestGeneration,
    documentGeneration: state.documentGeneration,
    documentUrl: currentDocumentUrl,
    expiresAt: Date.now() + TRUST_LIFETIME_MS,
  };
  return true;
}

/** Revokes all clipboard trust for one exact Preview guest generation. */
export function unregisterPreviewClipboardGuest(webContents: WebContents): void {
  const state = guests.get(webContents.id);
  if (!state || state.webContents !== webContents) return;
  guests.delete(webContents.id);
  state.dispose();
}
