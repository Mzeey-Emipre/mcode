import {
  BrowserWindow,
  ipcMain,
  webContents as electronWebContents,
} from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { logger } from "@mcode/shared";
import {
  applyPageStatus,
  emitTabsUpdated,
  getSession,
  getThreadTabSet,
  type TabState,
} from "../state/window-session.js";
import { resolvePreviewNavigationTarget } from "../navigation/resolve-target.js";
import { trustMainProcessFileNavigation } from "../navigation/local-file.js";
import { loadPreviewGuestUrl } from "../navigation/guest-navigation.js";
import {
  registerPreviewClipboardGuest,
  unregisterPreviewClipboardGuest,
} from "../security/clipboard-trust.js";
import { previewSessionAdapter } from "../security/electron-session-policy.js";
import { PREVIEW_POPUP_REQUESTED_CHANNEL } from "../contracts/popup.js";
import type { PreviewPopupSurfaceRef } from "../contracts/popup.js";
import { isBrowserAutomationAgentOperationActive } from "../automation/active-operation.js";
import { PREVIEW_SURFACE_DISCARD_REQUESTED_CHANNEL } from "../contracts/surface-lifecycle.js";
import { bumpPerf } from "../observability/perf-counters.js";

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
  | {
      readonly ok: false;
      readonly error: string;
      readonly errorCode?: string | number;
      readonly nextGeneration?: number;
    };

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
  readonly reason: "discard" | "replace" | "dispose" | "loss";
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

function validSurfaceGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function validateSurfaceScope(value: unknown): PreviewSurfaceIdentity["scope"] | null {
  if (typeof value !== "object" || value === null) return null;
  const scope = value as Partial<PreviewSurfaceIdentity["scope"]>;
  if (scope.kind !== "thread" && scope.kind !== "workspace") return null;
  if (!validBoundedId(scope.id)) return null;
  return { kind: scope.kind, id: scope.id.trim() };
}

function validateSurfaceIdentity(value: unknown): PreviewSurfaceIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const identity = value as Partial<PreviewSurfaceIdentity>;
  const scope = validateSurfaceScope(identity.scope);
  if (!validBoundedId(identity.workspaceId) || !validBoundedId(identity.tabId) || !scope) return null;
  return { workspaceId: identity.workspaceId.trim(), scope, tabId: identity.tabId.trim() };
}

function validateSurface(value: unknown): PreviewSurfaceRef | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<PreviewSurfaceRef>;
  const identity = validateSurfaceIdentity(candidate.identity);
  if (!validSurfaceGeneration(candidate.generation) || !identity) return null;
  return {
    identity,
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
): { threadId: string; tabId: string; tab: TabState } | null {
  const session = getSession(win);
  if (session.workspaceId !== identity.workspaceId) return null;
  if (identity.scope.kind === "thread") {
    const tab = getThreadTabSet(session, identity.scope.id, identity.workspaceId)?.tabs.find((candidate) => candidate.id === identity.tabId);
    return tab?.threadId === identity.scope.id
      ? { threadId: identity.scope.id, tabId: tab.id, tab }
      : null;
  }
  if (identity.scope.id !== identity.workspaceId) return null;
  let found: { threadId: string; tabId: string; tab: TabState } | null = null;
  for (const tabSet of session.tabsByThread.values()) {
    const tab = tabSet.tabs.find((candidate) => candidate.id === identity.tabId);
    if (!tab) continue;
    if (found) return null;
    found = { threadId: tab.threadId, tabId: tab.id, tab };
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

function errorResult(error: string, errorCode?: string | number): PreviewSurfaceResult {
  return { ok: false, error, ...(errorCode === undefined ? {} : { errorCode }) };
}

function staleGenerationResult(currentGeneration: number): PreviewSurfaceResult {
  return { ok: false, error: "stale-generation", nextGeneration: currentGeneration + 1 };
}

function isSurfaceResult(value: unknown): value is PreviewSurfaceResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

function asPrepareInput(value: unknown): Partial<PreviewSurfacePrepareInput> {
  return typeof value === "object" && value !== null ? value as Partial<PreviewSurfacePrepareInput> : {};
}

function validateSenderAndSurface(
  event: IpcMainInvokeEvent,
  surfaceValue: unknown,
): {
  win: BrowserWindow;
  surface: PreviewSurfaceRef;
  owner: { threadId: string; tabId: string; tab: TabState };
} | PreviewSurfaceResult {
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

function validReleaseReason(value: unknown): value is PreviewSurfaceReleaseInput["reason"] {
  return value === "discard" || value === "replace" || value === "dispose" || value === "loss";
}

function setRendererResidency(
  win: BrowserWindow,
  owner: { threadId: string; tabId: string; tab: TabState },
  generation: number | null,
): void {
  if (owner.tab.rendererSurfaceGeneration === generation) return;
  owner.tab.rendererSurfaceGeneration = generation;
  emitTabsUpdated(win, getSession(win), owner.threadId);
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

/** Requests renderer-side discard for one adopted surface selected by Memory Saver. */
export function requestRendererSurfaceDiscard(
  win: BrowserWindow,
  workspaceId: string,
  threadId: string,
  tabId: string,
): boolean {
  const records = adoptedByWindow.get(win.id);
  const record = [...(records?.values() ?? [])].find((candidate) =>
    candidate.surface.identity.workspaceId === workspaceId &&
    candidate.surface.identity.scope.kind === "thread" &&
    candidate.surface.identity.scope.id === threadId &&
    candidate.surface.identity.tabId === tabId &&
    !candidate.webContents.isDestroyed());
  if (!record || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  win.webContents.send(PREVIEW_SURFACE_DISCARD_REQUESTED_CHANNEL, record.surface);
  return true;
}

/** Releases all adopted and pending surfaces owned by one closing renderer window. */
export function disposePreviewSurfacesForWindow(windowId: number): void {
  const adopted = adoptedByWindow.get(windowId);
  for (const key of Array.from(adopted?.keys() ?? [])) {
    dropAdoption(windowId, key);
  }
  pendingByWindow.delete(windowId);
  generationByWindow.delete(windowId);
}

function adoptionTokenExists(records: Iterable<Map<string, { adoptionToken: string }>>, token: string): boolean {
  for (const entries of records) {
    for (const candidate of entries.values()) {
      if (candidate.adoptionToken === token) return true;
    }
  }
  return false;
}

function hasExistingToken(token: string): boolean {
  return adoptionTokenExists(pendingByWindow.values(), token) || adoptionTokenExists(adoptedByWindow.values(), token);
}

function prepareGeneration(win: BrowserWindow, surface: PreviewSurfaceRef): PreviewSurfaceResult | { key: string; adopted: AdoptionRecord | undefined; pending: PreviewSurfacePrepareInput | undefined } {
  const key = surfaceKey(surface.identity);
  const adopted = adoptedByWindow.get(win.id)?.get(key);
  if (adopted?.surface.generation === surface.generation) return errorResult("duplicate-adoption");
  const pending = pendingByWindow.get(win.id)?.get(key);
  if (pending?.surface.generation === surface.generation) return errorResult("duplicate-adoption");
  const currentGeneration = generationByWindow.get(win.id)?.get(key);
  if (currentGeneration !== undefined && surface.generation <= currentGeneration) return staleGenerationResult(currentGeneration);
  return { key, adopted, pending };
}

function replacePreparedSurface(windowId: number, key: string, adopted: AdoptionRecord | undefined, pending: PreviewSurfacePrepareInput | undefined): void {
  if (adopted) dropAdoption(windowId, key);
  if (pending) dropPending(windowId, key);
}

function prepareSurface(event: IpcMainInvokeEvent, inputValue: unknown): PreviewSurfaceResult {
  const input = asPrepareInput(inputValue);
  if (!validAdoptionToken(input.adoptionToken)) return errorResult("invalid-adoption-token");
  const validated = validateSenderAndSurface(event, input.surface);
  if (isSurfaceResult(validated)) return validated;
  const { win, surface } = validated;
  const generation = prepareGeneration(win, surface);
  if (isSurfaceResult(generation)) return generation;
  if (hasExistingToken(input.adoptionToken)) return errorResult("duplicate-adoption-token");
  replacePreparedSurface(win.id, generation.key, generation.adopted, generation.pending);
  windowMap(generationByWindow, win.id).set(generation.key, surface.generation);
  windowMap(pendingByWindow, win.id).set(generation.key, { surface, adoptionToken: input.adoptionToken });
  return { ok: true };
}

function validateAdoptionSlot(
  win: BrowserWindow,
  surface: PreviewSurfaceRef,
  adoptionToken: string,
  key: string,
): PreviewSurfaceResult | null {
  if (generationByWindow.get(win.id)?.get(key) !== surface.generation) return errorResult("stale-generation");
  const pending = pendingForWindow(win.id, surface);
  if (!pending || pending.adoptionToken !== adoptionToken) return errorResult("adoption-not-prepared");
  return adoptedByWindow.get(win.id)?.has(key) ? errorResult("duplicate-adoption") : null;
}

function guestForAdoption(sender: WebContents, adoptionToken: string): WebContents | PreviewSurfaceResult {
  const guest = findPendingGuest(sender, adoptionToken);
  if (guest) return guest;
  const matches = electronWebContents.getAllWebContents().filter((candidate) =>
    candidate.getURL() === `about:blank#${adoptionToken}` && candidate.hostWebContents === sender);
  return errorResult(matches.length > 1 ? "non-unique-adoption" : "guest-not-found");
}

function registerAdoptedGuest(
  event: IpcMainInvokeEvent,
  win: BrowserWindow,
  surface: PreviewSurfaceRef,
  owner: { threadId: string; tabId: string; tab: TabState },
  key: string,
  guest: WebContents,
): AdoptionRecord {
  const onDestroyed = () => {
    dropAdoption(win.id, key);
    setRendererResidency(win, owner, null);
  };
  guest.once("destroyed", onDestroyed);
  const disposePopup = previewSessionAdapter.bindGuestPopup(guest, {
    sourceSurface: surface,
    emitPopup: (request) => emitPreviewPopup(event.sender, win, request),
    isAgentOperationActive: isBrowserAutomationAgentOperationActive,
  });
  registerPreviewClipboardGuest(guest, () => ownsFocusedAdoptedGuest(win, key, guest, surface));
  return {
    surface,
    adoptionToken: "",
    webContents: guest,
    dispose: () => {
      guest.removeListener("destroyed", onDestroyed);
      disposePopup();
    },
  };
}

function emitPreviewPopup(sender: WebContents, win: BrowserWindow, request: unknown): void {
  if (!win.isDestroyed() && !sender.isDestroyed()) sender.send(PREVIEW_POPUP_REQUESTED_CHANNEL, request);
}

function ownsFocusedAdoptedGuest(win: BrowserWindow, key: string, guest: WebContents, surface: PreviewSurfaceRef): boolean {
  if (win.isDestroyed() || !win.isFocused()) return false;
  const record = adoptedByWindow.get(win.id)?.get(key);
  return record?.webContents === guest && record?.surface.generation === surface.generation;
}

function adoptSurface(event: IpcMainInvokeEvent, inputValue: unknown): PreviewSurfaceResult {
  const input = asPrepareInput(inputValue);
  if (!validAdoptionToken(input.adoptionToken)) return errorResult("invalid-adoption-token");
  const validated = validateSenderAndSurface(event, input.surface);
  if (isSurfaceResult(validated)) return validated;
  const { win, surface, owner } = validated;
  const key = surfaceKey(surface.identity);
  const slotError = validateAdoptionSlot(win, surface, input.adoptionToken, key);
  if (slotError) return slotError;
  const guest = guestForAdoption(event.sender, input.adoptionToken);
  if (isSurfaceResult(guest)) return guest;
  const record = registerAdoptedGuest(event, win, surface, owner, key, guest);
  windowMap(adoptedByWindow, win.id).set(key, { ...record, adoptionToken: input.adoptionToken });
  dropPending(win.id, key);
  setRendererResidency(win, owner, surface.generation);
  logger.info("Preview: adopted typed webview surface", {
    workspaceId: surface.identity.workspaceId,
    scope: surface.identity.scope,
    tabId: surface.identity.tabId,
    generation: surface.generation,
  });
  return { ok: true };
}

function asReleaseInput(value: unknown): Partial<PreviewSurfaceReleaseInput> {
  return typeof value === "object" && value !== null ? value as Partial<PreviewSurfaceReleaseInput> : {};
}

function releaseRecordForSender(win: BrowserWindow, sender: WebContents, key: string): PreviewSurfaceResult | null {
  const record = adoptedByWindow.get(win.id)?.get(key);
  if (!record) return null;
  if (record.webContents.hostWebContents !== sender) return errorResult("webcontents-owner-mismatch");
  dropAdoption(win.id, key);
  return null;
}

function applyDiscardRelease(win: BrowserWindow, owner: { threadId: string; tabId: string; tab: TabState }, surface: PreviewSurfaceRef): void {
  const session = getSession(win);
  const activeTabId = getThreadTabSet(session, owner.threadId, surface.identity.workspaceId)?.activeTabId;
  if (session.lastPreviewThreadId === owner.threadId && activeTabId === owner.tabId) {
    applyPageStatus(win, session, { type: "discard" });
  }
  bumpPerf("inactiveTabBudgetEvictions");
}

function clearReleasedResidency(
  win: BrowserWindow,
  owner: { threadId: string; tabId: string; tab: TabState } | null,
  surface: PreviewSurfaceRef,
  reason: PreviewSurfaceReleaseInput["reason"],
): void {
  if (!owner) return;
  setRendererResidency(win, owner, null);
  if (reason === "discard") applyDiscardRelease(win, owner, surface);
}

function releaseSurface(event: IpcMainInvokeEvent, inputValue: unknown): PreviewSurfaceResult {
  const input = asReleaseInput(inputValue);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return errorResult("no-window");
  const surface = validateSurface(input.surface);
  if (!surface) return errorResult("invalid-surface");
  if (!validReleaseReason(input.reason)) return errorResult("invalid-release-reason");
  const key = surfaceKey(surface.identity);
  const owner = findOwnedTab(win, surface.identity);
  const currentGeneration = generationByWindow.get(win.id)?.get(key);
  if (currentGeneration !== surface.generation) return errorResult("stale-generation");
  const recordError = releaseRecordForSender(win, event.sender, key);
  if (recordError) return recordError;
  dropPending(win.id, key);
  clearReleasedResidency(win, owner, surface, input.reason);
  return { ok: true };
}

interface NavigationContext {
  readonly win: BrowserWindow;
  readonly surface: PreviewSurfaceRef;
  readonly sender: WebContents;
  readonly guest: WebContents;
}

interface NavigationInput {
  readonly kind: string;
  readonly address?: unknown;
}

function asNavigationInput(value: unknown): NavigationInput | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as { kind?: unknown; address?: unknown };
  return typeof input.kind === "string" ? { kind: input.kind, address: input.address } : null;
}

function isCurrentNavigationGuest(context: NavigationContext): boolean {
  const current = resolveAdoptedPreviewSurfaceForWindow(context.win.id, context.surface, context.sender);
  return current?.webContents === context.guest;
}

async function navigateToAddress(context: NavigationContext, navigation: NavigationInput): Promise<PreviewSurfaceResult> {
  const address = typeof navigation.address === "string" ? navigation.address.trim() : "";
  if (navigation.kind === "initial" && !address) return { ok: true };
  const resolved = await resolvePreviewNavigationTarget(address);
  if (!resolved.ok) return errorResult(resolved.error);
  if (!isCurrentNavigationGuest(context)) return errorResult("stale-generation");
  trustMainProcessFileNavigation(getSession(context.win), resolved.url);
  const result = await loadPreviewGuestUrl(context.guest, resolved.url);
  return result.status === "committed" ? { ok: true } : errorResult("navigation-failed", result.errorCode ?? result.errorNumber);
}

function navigateHistory(context: NavigationContext, direction: "back" | "forward"): PreviewSurfaceResult {
  const canNavigate = direction === "back" ? context.guest.canGoBack() : context.guest.canGoForward();
  if (!canNavigate) return errorResult("history-unavailable");
  if (!isCurrentNavigationGuest(context)) return errorResult("stale-generation");
  if (direction === "back") context.guest.goBack();
  else context.guest.goForward();
  return { ok: true };
}

function reloadNavigation(context: NavigationContext, ignoreCache: boolean): PreviewSurfaceResult {
  if (!isCurrentNavigationGuest(context)) return errorResult("stale-generation");
  if (ignoreCache) context.guest.reloadIgnoringCache();
  else context.guest.reload();
  return { ok: true };
}

const navigationHandlers: Record<string, (context: NavigationContext, navigation: NavigationInput) => PreviewSurfaceResult | Promise<PreviewSurfaceResult>> = {
  initial: navigateToAddress,
  restored: navigateToAddress,
  address: navigateToAddress,
  back: (context) => navigateHistory(context, "back"),
  forward: (context) => navigateHistory(context, "forward"),
  reload: (context) => reloadNavigation(context, false),
  "force-reload": (context) => reloadNavigation(context, true),
};

async function navigateSurface(event: IpcMainInvokeEvent, inputValue: unknown): Promise<PreviewSurfaceResult> {
  const input = typeof inputValue === "object" && inputValue !== null ? inputValue as Partial<PreviewSurfaceNavigateInput> : {};
  const validated = validateSenderAndSurface(event, input.surface);
  if (isSurfaceResult(validated)) return validated;
  const { win, surface } = validated;
  const navigation = asNavigationInput(input.navigation);
  if (!navigation) return errorResult("invalid-navigation");
  const record = resolveAdoptedPreviewSurfaceForWindow(win.id, surface, event.sender);
  if (!record) return errorResult("stale-generation");
  if (!Object.hasOwn(navigationHandlers, navigation.kind)) return errorResult("invalid-navigation");
  const handler = navigationHandlers[navigation.kind];
  try {
    return await handler({ win, surface, sender: event.sender, guest: record.webContents }, navigation);
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
