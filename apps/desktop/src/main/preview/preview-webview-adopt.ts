import {
  BrowserWindow,
  ipcMain,
  webContents as electronWebContents,
} from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { logger } from "@mcode/shared";
import { getSession, getThreadTabSet } from "./preview-session.js";
import { resolvePreviewNavigationTarget } from "./preview-navigation.js";
import { trustMainProcessFileNavigation } from "./preview-local-file.js";
import {
  registerPreviewClipboardGuest,
  unregisterPreviewClipboardGuest,
} from "./preview-clipboard-trust.js";
import { previewSessionAdapter } from "./preview-session-adapter.js";
import { PREVIEW_POPUP_REQUESTED_CHANNEL } from "./preview-popup-contract.js";
import type { PreviewPopupSurfaceRef } from "./preview-popup-contract.js";
import { isBrowserAutomationAgentOperationActive } from "../browser-automation/active-operation.js";

const MAX_SURFACE_ID_LENGTH = 256;
const MAX_ADOPTION_TOKEN_LENGTH = 128;

/** Complete identity of one renderer-owned Preview surface. */
export interface PreviewSurfaceIdentity {
  readonly workspaceId: string;
  readonly scope: {
    readonly kind: "thread" | "workspace";
    readonly id: string;
  };
  readonly tabId: string;
}

/** Complete identity and generation for one renderer-hosted Preview surface. */
export interface PreviewSurfaceRef extends PreviewPopupSurfaceRef {
  readonly identity: PreviewSurfaceIdentity;
}

/** Typed navigation requested by a renderer-owned Preview surface. */
export type PreviewSurfaceNavigation =
  | { readonly kind: "initial"; readonly address?: string }
  | { readonly kind: "restored" | "address"; readonly address: string }
  | { readonly kind: "back" | "forward" | "reload" | "force-reload" };

/** Result returned by a typed Preview surface operation. */
export type PreviewSurfaceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** Pending or adopted exact Preview guest held by Electron main. */
export interface AdoptedPreviewSurface {
  readonly surface: PreviewSurfaceRef;
  readonly adoptionToken: string;
  readonly webContents: WebContents;
}

interface AdoptionRecord extends AdoptedPreviewSurface {
  readonly dispose: () => void;
}

/** Input accepted by preview.surface.prepare. */
export interface PreviewSurfacePrepareInput {
  readonly surface: PreviewSurfaceRef;
  readonly adoptionToken: string;
}

/** Input accepted by preview.surface.adopt. */
export interface PreviewSurfaceAdoptInput extends PreviewSurfacePrepareInput {}

/** Input accepted by preview.surface.release. */
export interface PreviewSurfaceReleaseInput {
  readonly surface: PreviewSurfaceRef;
}

/** Input accepted by preview.surface.navigate. */
export interface PreviewSurfaceNavigateInput {
  readonly surface: PreviewSurfaceRef;
  readonly navigation: PreviewSurfaceNavigation;
}

/** Per-window adopted and pending Preview surfaces. */
const adoptedByWindow = new Map<number, Map<string, AdoptionRecord>>();
const pendingByWindow = new Map<number, Map<string, PreviewSurfacePrepareInput>>();
const generationByWindow = new Map<number, Map<string, number>>();

function surfaceKey(identity: PreviewSurfaceIdentity): string {
  return JSON.stringify([
    identity.workspaceId,
    identity.scope.kind,
    identity.scope.id,
    identity.tabId,
  ]);
}

function validBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_SURFACE_ID_LENGTH;
}

function validateSurface(value: unknown): PreviewSurfaceRef | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<PreviewSurfaceRef>;
  const identity = candidate.identity;
  if (typeof candidate.generation !== "number" || !Number.isSafeInteger(candidate.generation) || candidate.generation < 1) return null;
  if (typeof identity !== "object" || identity === null) return null;
  const typedIdentity = identity as Partial<PreviewSurfaceIdentity>;
  const scope = typedIdentity.scope;
  if (
    !validBoundedId(typedIdentity.workspaceId) ||
    typeof scope !== "object" ||
    scope === null ||
    (scope.kind !== "thread" && scope.kind !== "workspace") ||
    !validBoundedId(scope.id) ||
    !validBoundedId(typedIdentity.tabId)
  ) return null;
  return {
    identity: {
      workspaceId: typedIdentity.workspaceId.trim(),
      scope: { kind: scope.kind, id: scope.id.trim() },
      tabId: typedIdentity.tabId.trim(),
    },
    generation: candidate.generation,
  };
}

function validAdoptionToken(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 8 &&
    value.length <= MAX_ADOPTION_TOKEN_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

function windowMap<T>(maps: Map<number, Map<string, T>>, windowId: number): Map<string, T> {
  let map = maps.get(windowId);
  if (!map) {
    map = new Map();
    maps.set(windowId, map);
  }
  return map;
}

function findOwnedTab(
  win: BrowserWindow,
  identity: PreviewSurfaceIdentity,
): { threadId: string; tabId: string } | null {
  const session = getSession(win);
  if (session.workspaceId !== identity.workspaceId) return null;
  if (identity.scope.kind === "thread") {
    const tab = getThreadTabSet(session, identity.scope.id, identity.workspaceId)?.tabs.find((candidate) => candidate.id === identity.tabId);
    return tab?.threadId === identity.scope.id ? { threadId: identity.scope.id, tabId: tab.id } : null;
  }
  if (identity.scope.id !== identity.workspaceId) return null;
  let found: { threadId: string; tabId: string } | null = null;
  for (const tabSet of session.tabsByThread.values()) {
    const tab = tabSet.tabs.find((candidate) => candidate.id === identity.tabId);
    if (!tab) continue;
    if (found) return null;
    found = { threadId: tab.threadId, tabId: tab.id };
  }
  return found;
}

function pendingForWindow(windowId: number, surface: PreviewSurfaceRef): PreviewSurfacePrepareInput | null {
  return pendingByWindow.get(windowId)?.get(surfaceKey(surface.identity)) ?? null;
}

function adoptedForWindow(windowId: number, surface: PreviewSurfaceRef): AdoptionRecord | null {
  const record = adoptedByWindow.get(windowId)?.get(surfaceKey(surface.identity));
  if (!record || record.surface.generation !== surface.generation || record.webContents.isDestroyed()) return null;
  return record;
}

function isInertGuestUrl(url: string, adoptionToken: string): boolean {
  return url === `about:blank#${adoptionToken}`;
}

function guestMatchesPending(
  guest: WebContents,
  sender: WebContents,
  adoptionToken: string,
): boolean {
  if (guest.isDestroyed() || guest.getType() !== "webview") return false;
  if (guest.hostWebContents !== sender) return false;
  // The main window's will-attach-webview hook replaces the preload and
  // partition before this guest exists. Electron omits preload from
  // getLastWebPreferences(), so the enforced partition is the runtime proof.
  if (guest.session !== previewSessionAdapter.session) return false;
  return isInertGuestUrl(guest.getURL(), adoptionToken);
}

function findPendingGuest(sender: WebContents, adoptionToken: string): WebContents | null {
  const guests = electronWebContents.getAllWebContents().filter((candidate) =>
    guestMatchesPending(candidate, sender, adoptionToken));
  return guests.length === 1 ? guests[0]! : null;
}

function errorResult(error: string): PreviewSurfaceResult {
  return { ok: false, error };
}

function validateSenderAndSurface(
  event: IpcMainInvokeEvent,
  surfaceValue: unknown,
): { win: BrowserWindow; surface: PreviewSurfaceRef; owner: { threadId: string; tabId: string } } | PreviewSurfaceResult {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return errorResult("no-window");
  const surface = validateSurface(surfaceValue);
  if (!surface) return errorResult("invalid-surface");
  const owner = findOwnedTab(win, surface.identity);
  if (!owner) return errorResult("surface-owner-mismatch");
  return { win, surface, owner };
}

function dropAdoption(windowId: number, key: string): void {
  const map = adoptedByWindow.get(windowId);
  const record = map?.get(key);
  if (!record) return;
  unregisterPreviewClipboardGuest(record.webContents);
  try {
    record.dispose();
  } catch {
    // The guest may already have been destroyed.
  }
  map!.delete(key);
  if (map!.size === 0) adoptedByWindow.delete(windowId);
}

function dropPending(windowId: number, key: string): void {
  const map = pendingByWindow.get(windowId);
  map?.delete(key);
  if (map && map.size === 0) pendingByWindow.delete(windowId);
}

/** Resolves the adopted guest for an exact identity and generation. */
export function resolveAdoptedPreviewSurfaceForWindow(
  windowId: number,
  surface: PreviewSurfaceRef,
  sender?: WebContents,
): AdoptedPreviewSurface | null {
  const record = adoptedForWindow(windowId, surface);
  if (!record) return null;
  if (sender && record.webContents.hostWebContents !== sender) return null;
  return record;
}

/** Legacy resolver retained for existing main-process automation call sites. */
export function findAdoptedWebContentsForWindow(
  windowId: number,
  threadId: string,
  tabId: string,
  generation?: number,
): WebContents | null {
  const records = adoptedByWindow.get(windowId);
  for (const record of records?.values() ?? []) {
    if (
      record.surface.identity.scope.kind === "thread" &&
      record.surface.identity.scope.id === threadId &&
      record.surface.identity.tabId === tabId &&
      (generation === undefined || record.surface.generation === generation) &&
      !record.webContents.isDestroyed()
    ) return record.webContents;
  }
  return null;
}

function prepareSurface(event: IpcMainInvokeEvent, inputValue: unknown): PreviewSurfaceResult {
  const input = typeof inputValue === "object" && inputValue !== null ? inputValue as Partial<PreviewSurfacePrepareInput> : {};
  if (!validAdoptionToken(input.adoptionToken)) return errorResult("invalid-adoption-token");
  const validated = validateSenderAndSurface(event, input.surface);
  if ("ok" in validated) return validated;
  const { win, surface } = validated;
  const key = surfaceKey(surface.identity);
  const adopted = adoptedByWindow.get(win.id)?.get(key);
  if (adopted?.surface.generation === surface.generation) return errorResult("duplicate-adoption");
  if (adopted && surface.generation < adopted.surface.generation) return errorResult("stale-generation");
  const pending = pendingByWindow.get(win.id)?.get(key);
  if (pending?.surface.generation === surface.generation) return errorResult("duplicate-adoption");
  if (pending && surface.generation < pending.surface.generation) return errorResult("stale-generation");
  const generations = generationByWindow.get(win.id)?.get(key);
  if (generations !== undefined && surface.generation <= generations) return errorResult("stale-generation");
  for (const records of pendingByWindow.values()) {
    for (const candidate of records.values()) {
      if (candidate.adoptionToken === input.adoptionToken) return errorResult("duplicate-adoption-token");
    }
  }
  for (const records of adoptedByWindow.values()) {
    for (const candidate of records.values()) {
      if (candidate.adoptionToken === input.adoptionToken) return errorResult("duplicate-adoption-token");
    }
  }
  if (adopted) dropAdoption(win.id, key);
  if (pending) dropPending(win.id, key);
  windowMap(generationByWindow, win.id).set(key, surface.generation);
  windowMap(pendingByWindow, win.id).set(key, { surface, adoptionToken: input.adoptionToken });
  return { ok: true };
}

function adoptSurface(event: IpcMainInvokeEvent, inputValue: unknown): PreviewSurfaceResult {
  const input = typeof inputValue === "object" && inputValue !== null ? inputValue as Partial<PreviewSurfaceAdoptInput> : {};
  if (!validAdoptionToken(input.adoptionToken)) return errorResult("invalid-adoption-token");
  const validated = validateSenderAndSurface(event, input.surface);
  if ("ok" in validated) return validated;
  const { win, surface } = validated;
  const key = surfaceKey(surface.identity);
  const currentGeneration = generationByWindow.get(win.id)?.get(key);
  if (currentGeneration !== surface.generation) return errorResult("stale-generation");
  const pending = pendingForWindow(win.id, surface);
  if (!pending || pending.adoptionToken !== input.adoptionToken) return errorResult("adoption-not-prepared");
  if (adoptedByWindow.get(win.id)?.has(key)) return errorResult("duplicate-adoption");
  const guest = findPendingGuest(event.sender, input.adoptionToken);
  if (!guest) {
    const matches = electronWebContents.getAllWebContents().filter((candidate) =>
      candidate.getURL() === `about:blank#${input.adoptionToken}` && candidate.hostWebContents === event.sender);
    return errorResult(matches.length > 1 ? "non-unique-adoption" : "guest-not-found");
  }
  const onDestroyed = () => dropAdoption(win.id, key);
  guest.once("destroyed", onDestroyed);
  const disposePopup = previewSessionAdapter.bindGuestPopup(guest, {
    sourceSurface: surface,
    emitPopup: (request) => {
      if (!win.isDestroyed() && !event.sender.isDestroyed()) {
        event.sender.send(PREVIEW_POPUP_REQUESTED_CHANNEL, request);
      }
    },
    isAgentOperationActive: isBrowserAutomationAgentOperationActive,
  });
  registerPreviewClipboardGuest(guest, () => {
    if (win.isDestroyed() || !win.isFocused()) return false;
    const record = adoptedByWindow.get(win.id)?.get(key);
    return record?.webContents === guest && record?.surface.generation === surface.generation;
  });
  const dispose = () => {
    guest.removeListener("destroyed", onDestroyed);
    disposePopup();
  };
  windowMap(adoptedByWindow, win.id).set(key, { surface, adoptionToken: input.adoptionToken, webContents: guest, dispose });
  dropPending(win.id, key);
  logger.info("Preview: adopted typed webview surface", {
    workspaceId: surface.identity.workspaceId,
    scope: surface.identity.scope,
    tabId: surface.identity.tabId,
    generation: surface.generation,
  });
  return { ok: true };
}

function releaseSurface(event: IpcMainInvokeEvent, inputValue: unknown): PreviewSurfaceResult {
  const input = typeof inputValue === "object" && inputValue !== null ? inputValue as Partial<PreviewSurfaceReleaseInput> : {};
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return errorResult("no-window");
  const surface = validateSurface(input.surface);
  if (!surface) return errorResult("invalid-surface");
  const key = surfaceKey(surface.identity);
  const currentGeneration = generationByWindow.get(win.id)?.get(key);
  if (currentGeneration !== surface.generation) return errorResult("stale-generation");
  const record = adoptedByWindow.get(win.id)?.get(key);
  if (record) {
    if (record.webContents.hostWebContents !== event.sender) return errorResult("webcontents-owner-mismatch");
    dropAdoption(win.id, key);
  }
  dropPending(win.id, key);
  return { ok: true };
}

async function navigateSurface(event: IpcMainInvokeEvent, inputValue: unknown): Promise<PreviewSurfaceResult> {
  const input = typeof inputValue === "object" && inputValue !== null ? inputValue as Partial<PreviewSurfaceNavigateInput> : {};
  const validated = validateSenderAndSurface(event, input.surface);
  if ("ok" in validated) return validated;
  const { win, surface } = validated;
  const navigation = input.navigation;
  if (typeof navigation !== "object" || navigation === null || typeof navigation.kind !== "string") return errorResult("invalid-navigation");
  // Resolve immediately before the side effect. A replacement or release that
  // raced validation must not inherit the prior guest's authority.
  const record = resolveAdoptedPreviewSurfaceForWindow(win.id, surface, event.sender);
  if (!record) return errorResult("stale-generation");
  const guest = record.webContents;
  try {
    switch (navigation.kind) {
      case "initial":
      case "restored":
      case "address": {
        const address = typeof navigation.address === "string" ? navigation.address.trim() : "";
        if (navigation.kind === "initial" && !address) return { ok: true };
        const resolved = await resolvePreviewNavigationTarget(address);
        if (!resolved.ok) return errorResult(resolved.error);
        const current = resolveAdoptedPreviewSurfaceForWindow(win.id, surface, event.sender);
        if (!current || current.webContents !== guest) return errorResult("stale-generation");
        trustMainProcessFileNavigation(getSession(win), resolved.url);
        await guest.loadURL(resolved.url);
        return { ok: true };
      }
      case "back":
        if (!guest.canGoBack()) return errorResult("history-unavailable");
        if (!resolveAdoptedPreviewSurfaceForWindow(win.id, surface, event.sender)) return errorResult("stale-generation");
        guest.goBack();
        return { ok: true };
      case "forward":
        if (!guest.canGoForward()) return errorResult("history-unavailable");
        if (!resolveAdoptedPreviewSurfaceForWindow(win.id, surface, event.sender)) return errorResult("stale-generation");
        guest.goForward();
        return { ok: true };
      case "reload":
        if (!resolveAdoptedPreviewSurfaceForWindow(win.id, surface, event.sender)) return errorResult("stale-generation");
        guest.reload();
        return { ok: true };
      case "force-reload":
        if (!resolveAdoptedPreviewSurfaceForWindow(win.id, surface, event.sender)) return errorResult("stale-generation");
        guest.reloadIgnoringCache();
        return { ok: true };
      default:
        return errorResult("invalid-navigation");
    }
  } catch {
    return errorResult("navigation-failed");
  }
}

/** Registers the generation-bound Preview surface IPC channels. */
let surfaceHandlersRegistered = false;
export function registerPreviewSurfaceHandlers(): void {
  if (surfaceHandlersRegistered) return;
  surfaceHandlersRegistered = true;
  ipcMain.handle("preview.surface.prepare", (event, input: unknown) => prepareSurface(event, input));
  ipcMain.handle("preview.surface.adopt", (event, input: unknown) => adoptSurface(event, input));
  ipcMain.handle("preview.surface.release", (event, input: unknown) => releaseSurface(event, input));
  ipcMain.handle("preview.surface.navigate", (event, input: unknown) => navigateSurface(event, input));
}

/** Backward-compatible registration name for the preview subsystem index. */
export const registerWebviewAdoptHandlers = registerPreviewSurfaceHandlers;

/** Test/internal helper that drops every pending and adopted surface. */
export function _resetAdoptionRegistryForTests(): void {
  for (const records of adoptedByWindow.values()) {
    for (const record of records.values()) {
      try {
        record.dispose();
      } catch {
        // Ignore already-destroyed guests during test cleanup.
      }
    }
  }
  adoptedByWindow.clear();
  pendingByWindow.clear();
  generationByWindow.clear();
}
