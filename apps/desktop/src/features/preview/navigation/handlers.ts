/** Navigation IPC handlers for BrowserSurfaceHost-owned Preview surfaces. */

import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { logger } from "@mcode/shared";
import { ensureThreadTabSet, getActiveTab, getSession, getThreadTabSet, setPreviewLoading, type Bounds, type PreviewSession } from "../state/window-session.js";
import { bumpPerf } from "../observability/perf-counters.js";
import { validateResumeUrl, trustMainProcessFileNavigation } from "./local-file.js";
import { isAllowedHttpUrl, isAllowedPreviewUrl } from "./policy.js";
import { resolvePreviewNavigationTarget, type PreviewResolveNavigationResult } from "./resolve-target.js";
import { loadPreviewGuestUrl } from "./guest-navigation.js";
import { onPreviewHidden, onPreviewVisible } from "../tabs/discard-scheduler.js";
import { previewSessionAdapter } from "../security/electron-session-policy.js";
import { findAdoptedWebContentsForWindow } from "../surfaces/registry.js";

const MIN_ZOOM_FACTOR = 0.25;
const MAX_ZOOM_FACTOR = 5;

interface SyncPayload {
  readonly visible: boolean;
  readonly bounds: Bounds | null;
  readonly threadId?: string | null;
  readonly resumeUrlHint?: string | null;
  readonly workspaceId?: string | null;
}

function clampZoomFactor(factor: number): number {
  const safe = Number.isFinite(factor) ? factor : 1;
  const bounded = Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, safe));
  return Math.round(bounded * 100) / 100;
}

function getWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender);
  return !win || win.isDestroyed() ? null : win;
}

function getActiveGuest(win: BrowserWindow, session: PreviewSession): WebContents | null {
  const threadId = session.lastPreviewThreadId;
  if (!threadId) return null;
  const tabSet = getThreadTabSet(session, threadId);
  const tab = tabSet?.tabs.find((candidate) => candidate.id === tabSet.activeTabId);
  if (!tab || tab.rendererSurfaceGeneration == null) return null;
  return findAdoptedWebContentsForWindow(win.id, threadId, tab.id, tab.rendererSurfaceGeneration);
}

function roundedBounds(bounds: Bounds | null): Bounds | null {
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
  if (bounds.width < 4 || bounds.height < 4) return null;
  return { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
}

function updateSyncScope(session: PreviewSession, payload: SyncPayload, bounds: Bounds | null): void {
  const workspaceId = payload.workspaceId;
  session.workspaceId = typeof workspaceId === "string" && workspaceId.trim().length > 0 ? workspaceId.trim() : null;
  if (!bounds) return;
  session.lastBounds = bounds;
  if (payload.threadId !== null && payload.threadId !== undefined) ensureThreadTabSet(session, payload.threadId);
  session.lastPreviewThreadId = payload.threadId ?? null;
}

function permittedResumeHint(value: string | null | undefined): string | null {
  const hint = value?.trim() ?? "";
  return hint.length > 0 && isAllowedPreviewUrl(hint) ? hint : null;
}

async function updateVisiblePreview(win: BrowserWindow, session: PreviewSession, payload: SyncPayload): Promise<void> {
  const threadId = payload.threadId;
  if (!threadId) return;
  const safeHint = await validateResumeUrl(permittedResumeHint(payload.resumeUrlHint));
  const activeTab = getActiveTab(session, threadId);
  if (!activeTab.resumeUrl && !activeTab.userCreatedBlank && safeHint) activeTab.resumeUrl = safeHint;
  session.resumePreviewUrl = activeTab.resumeUrl;
  session.lastFavicons = activeTab.faviconUrl ? [activeTab.faviconUrl] : [];
  onPreviewVisible(win, session);
}

async function handleSync(event: IpcMainInvokeEvent, payload: SyncPayload): Promise<void> {
  const win = getWindow(event);
  if (!win) return;
  const session = getSession(win);
  const bounds = roundedBounds(payload.bounds);
  bumpPerf("setPanelBoundsCalls");
  updateSyncScope(session, payload, bounds);
  if (!payload.visible || !bounds) {
    onPreviewHidden(win, session);
    return;
  }
  await updateVisiblePreview(win, session, payload);
}

async function handleResolveNavigation(event: IpcMainInvokeEvent, url: string, workspacePath?: string | null): Promise<PreviewResolveNavigationResult> {
  return getWindow(event) ? resolvePreviewNavigationTarget(url, workspacePath) : { ok: false, error: "no-window" };
}

function getNavigableGuest(event: IpcMainInvokeEvent): { win: BrowserWindow; session: PreviewSession; guest: WebContents } | null {
  const win = getWindow(event);
  if (!win) return null;
  return getNavigableGuestForWindow(win);
}

function getNavigableGuestForWindow(win: BrowserWindow): { win: BrowserWindow; session: PreviewSession; guest: WebContents } | null {
  const session = getSession(win);
  const guest = getActiveGuest(win, session);
  return guest ? { win, session, guest } : null;
}

async function handleNavigate(event: IpcMainInvokeEvent, url: string, workspacePath?: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const win = getWindow(event);
  if (!win) return { ok: false, error: "no-window" };
  const resolved = await resolvePreviewNavigationTarget(url, workspacePath);
  if (!resolved.ok) return resolved;
  const context = getNavigableGuestForWindow(win);
  if (!context) return { ok: false, error: "preview-unavailable" };
  const activeTab = context.session.lastPreviewThreadId ? getActiveTab(context.session, context.session.lastPreviewThreadId) : null;
  logger.info("Preview: user navigated", { url: resolved.url });
  setPreviewLoading(context.win, context.session, true);
  trustMainProcessFileNavigation(context.session, resolved.url);
  const result = await loadPreviewGuestUrl(context.guest, resolved.url);
  if (result.status === "failed") return { ok: false, error: "navigation-failed" };
  context.session.resumePreviewUrl = resolved.url;
  if (activeTab) activeTab.resumeUrl = resolved.url;
  return { ok: true };
}

function handleHistory(event: IpcMainInvokeEvent, direction: "back" | "forward"): boolean {
  const context = getNavigableGuest(event);
  if (!context) return false;
  const canNavigate = direction === "back" ? context.guest.canGoBack() : context.guest.canGoForward();
  if (!canNavigate) return false;
  setPreviewLoading(context.win, context.session, true);
  if (direction === "back") context.guest.goBack();
  else context.guest.goForward();
  return true;
}

function reloadActiveGuest(event: IpcMainInvokeEvent, ignoreCache: boolean): void {
  const context = getNavigableGuest(event);
  if (!context) return;
  setPreviewLoading(context.win, context.session, true);
  if (ignoreCache) context.guest.reloadIgnoringCache();
  else context.guest.reload();
}

async function clearPreviewStorage(event: IpcMainInvokeEvent, operation: "cookies" | "cache"): Promise<void> {
  if (!getWindow(event)) return;
  if (operation === "cookies") await previewSessionAdapter.clearCookies();
  else await previewSessionAdapter.clearCache();
}

function getZoom(event: IpcMainInvokeEvent): number {
  const context = getNavigableGuest(event);
  return context ? clampZoomFactor(context.guest.getZoomFactor()) : 1;
}

function setZoom(event: IpcMainInvokeEvent, factor: number): number {
  const context = getNavigableGuest(event);
  if (!context) return 1;
  const clamped = clampZoomFactor(factor);
  context.guest.setZoomFactor(clamped);
  return clamped;
}

function openActiveUrlExternally(event: IpcMainInvokeEvent): void {
  const context = getNavigableGuest(event);
  const url = context?.guest.getURL();
  if (!url || !isAllowedHttpUrl(url)) return;
  void shell.openExternal(url).catch(() => undefined);
}

function getNavigationState(event: IpcMainInvokeEvent): { canGoBack: boolean; canGoForward: boolean } {
  const context = getNavigableGuest(event);
  return context ? { canGoBack: context.guest.canGoBack(), canGoForward: context.guest.canGoForward() } : { canGoBack: false, canGoForward: false };
}

/** Registers the Preview navigation IPC handlers. */
export function registerNavigationHandlers(): void {
  ipcMain.handle("preview:sync", handleSync);
  ipcMain.handle("preview:resolve-navigation", handleResolveNavigation);
  ipcMain.handle("preview:navigate", handleNavigate);
  ipcMain.handle("preview:go-back", (event) => handleHistory(event, "back"));
  ipcMain.handle("preview:go-forward", (event) => handleHistory(event, "forward"));
  ipcMain.handle("preview:reload", (event) => reloadActiveGuest(event, false));
  ipcMain.handle("preview:force-reload", (event) => reloadActiveGuest(event, true));
  ipcMain.handle("preview:clear-cookies", (event) => clearPreviewStorage(event, "cookies"));
  ipcMain.handle("preview:clear-cache", (event) => clearPreviewStorage(event, "cache"));
  ipcMain.handle("preview:get-zoom", getZoom);
  ipcMain.handle("preview:set-zoom", setZoom);
  ipcMain.handle("preview:open-external", openActiveUrlExternally);
  ipcMain.handle("preview:get-navigation-state", getNavigationState);
}
