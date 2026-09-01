/** Tab IPC handlers for BrowserSurfaceHost-owned Preview pages. */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import * as NodeCrypto from "node:crypto";
import { BROWSER_TAB_INFO_STRING_MAX, type BrowserTabSet } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import {
  ensureThreadTabSet,
  getSession,
  previewTabScopeKey,
  toBrowserTabSet,
  type PreviewSession,
  type TabState,
} from "../state/window-session.js";
import { bumpPerf } from "../observability/perf-counters.js";
import { validatePreviewNavigationUrl } from "../navigation/resolve-target.js";

type TabIpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface TabContext {
  readonly win: BrowserWindow;
  readonly session: PreviewSession;
  readonly threadId: string;
  readonly workspaceId: string;
}

interface TabIdContext extends TabContext {
  readonly tabId: string;
}

interface OpenTabInput {
  readonly requestedTabId: string | null;
  readonly initialAddress: string | null | undefined;
  readonly activate: boolean;
}

interface ChromeUpdateInput {
  readonly title: string | null | undefined;
  readonly url: string | null | undefined;
  readonly faviconUrl: string | null | undefined;
  readonly updates: { title: boolean; url: boolean; faviconUrl: boolean };
}

const MAX_PREVIEW_ID_LENGTH = 256;

function error<T>(message: string): TabIpcResult<T> {
  return { ok: false, error: message };
}

function isTabError<T>(value: unknown): value is TabIpcResult<T> {
  return typeof value === "object" && value !== null && "ok" in value;
}

function normalisePreviewId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_PREVIEW_ID_LENGTH ? trimmed : null;
}

function normaliseChromeField(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) return undefined;
  return value;
}

async function normaliseInitialAddress(value: unknown): Promise<string | null | undefined> {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > BROWSER_TAB_INFO_STRING_MAX.url) {
    return null;
  }
  const result = await validatePreviewNavigationUrl(value);
  return result.ok ? result.url : null;
}

async function normaliseChromeUrl(value: unknown): Promise<string | null | undefined> {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > BROWSER_TAB_INFO_STRING_MAX.url) return undefined;
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.length === 0 || lower.startsWith("about:") || lower.startsWith("chrome-error:")) return null;
  return (await normaliseInitialAddress(trimmed)) ?? undefined;
}

function hasOwnField(value: unknown, field: string): boolean {
  return typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, field);
}

function sendTabsUpdated(win: BrowserWindow, set: BrowserTabSet): void {
  if (win.isDestroyed()) return;
  bumpPerf("stateEmitCalls");
  try {
    win.webContents.send("preview:tabs-updated", set);
  } catch {
    bumpPerf("stateEmitSkips");
  }
}

function activateTab(session: PreviewSession, tab: TabState): void {
  tab.lastActiveAt = Date.now();
  session.resumePreviewUrl = tab.resumeUrl;
  session.lastFavicons = tab.faviconUrl ? [tab.faviconUrl] : [];
}

function buildTabSet(session: PreviewSession, threadId: string): BrowserTabSet {
  return toBrowserTabSet(session, threadId);
}

function resolveTabContext(event: IpcMainInvokeEvent, payload: { threadId?: unknown; workspaceId?: unknown }): TabContext | TabIpcResult<never> {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return error("no-window");
  const threadId = normalisePreviewId(payload?.threadId);
  if (!threadId) return error("invalid-thread-id");
  const workspaceId = normalisePreviewId(payload?.workspaceId);
  if (!workspaceId) return error("invalid-workspace-id");
  const session = getSession(win);
  return { win, session, threadId, workspaceId };
}

function updateWorkspaceContext(context: TabContext): void {
  context.session.workspaceId = context.workspaceId;
}

function resolveTabIdContext(event: IpcMainInvokeEvent, payload: { threadId?: unknown; workspaceId?: unknown; tabId?: unknown }): TabIdContext | TabIpcResult<never> {
  const context = resolveTabContext(event, payload);
  if ("ok" in context) return context;
  const tabId = normalisePreviewId(payload?.tabId);
  if (!tabId) return error("invalid-tab-id");
  return { ...context, tabId };
}

function parseRequestedTabId(value: unknown, supplied: boolean): string | null | TabIpcResult<never> {
  if (!supplied) return null;
  const tabId = normalisePreviewId(value);
  return tabId ?? error("invalid-tab-id");
}

async function parseInitialAddress(value: unknown, supplied: boolean): Promise<string | null | undefined | TabIpcResult<never>> {
  const address = await normaliseInitialAddress(value);
  if (supplied && address === null) return error("invalid-initial-address");
  return address;
}

async function parseOpenTabInput(payload: { activate?: unknown; tabId?: unknown; initialAddress?: unknown }): Promise<OpenTabInput | TabIpcResult<never>> {
  const requestedTabId = parseRequestedTabId(payload?.tabId, payload?.tabId !== undefined);
  if (isTabError(requestedTabId)) return requestedTabId;
  const initialAddress = await parseInitialAddress(payload?.initialAddress, payload?.initialAddress !== undefined);
  if (isTabError(initialAddress)) return initialAddress;
  return { requestedTabId, initialAddress, activate: payload?.activate !== false };
}

function createBlankTab(threadId: string, tabId: string): TabState {
  return {
    id: tabId,
    threadId,
    resumeUrl: null,
    title: null,
    faviconUrl: null,
    lastActiveAt: Date.now(),
    userCreatedBlank: true,
  };
}

function applyInitialAddress(tab: TabState, initialAddress: string | null | undefined): void {
  if (initialAddress === undefined) return;
  tab.resumeUrl = initialAddress;
  tab.userCreatedBlank = false;
}

function selectOpenedTab(context: TabContext, tab: TabState, activate: boolean): void {
  if (!activate) return;
  const set = ensureThreadTabSet(context.session, context.threadId);
  set.activeTabId = tab.id;
  if (context.threadId === context.session.lastPreviewThreadId) activateTab(context.session, tab);
}

function openTab(context: TabContext, input: OpenTabInput): TabIpcResult<{ tabId: string; tabs: BrowserTabSet }> {
  const set = ensureThreadTabSet(context.session, context.threadId);
  const existingTab = input.requestedTabId ? set.tabs.find((tab) => tab.id === input.requestedTabId) : undefined;
  if (input.requestedTabId && !existingTab) return error("tab-not-found");
  if (existingTab?.backgroundOpenReserved) return error("tab-reserved");
  const tab = existingTab ?? createBlankTab(context.threadId, NodeCrypto.randomUUID());
  applyInitialAddress(tab, input.initialAddress);
  if (!existingTab) set.tabs.push(tab);
  if (existingTab && !input.activate) tab.backgroundOpenReserved = true;
  selectOpenedTab(context, tab, input.activate);
  const tabs = buildTabSet(context.session, context.threadId);
  sendTabsUpdated(context.win, tabs);
  logger.info("Preview: tab opened", { threadId: context.threadId, tabId: tab.id, activate: input.activate, reused: existingTab !== undefined });
  return { ok: true, data: { tabId: tab.id, tabs } };
}

function parseChromeField(value: unknown, supplied: boolean, maxLength: number): string | null | undefined | TabIpcResult<never> {
  if (!supplied) return undefined;
  const normalised = normaliseChromeField(value, maxLength);
  return normalised === undefined ? error("invalid-tab-chrome") : normalised;
}

async function parseChromeUrl(value: unknown, supplied: boolean): Promise<string | null | undefined | TabIpcResult<never>> {
  if (!supplied) return undefined;
  const normalised = await normaliseChromeUrl(value);
  return normalised === undefined ? error("invalid-tab-chrome") : normalised;
}

async function parseChromeUpdate(payload: { title?: unknown; url?: unknown; faviconUrl?: unknown }): Promise<ChromeUpdateInput | TabIpcResult<never>> {
  const updates = { title: hasOwnField(payload, "title"), url: hasOwnField(payload, "url"), faviconUrl: hasOwnField(payload, "faviconUrl") };
  const title = parseChromeField(payload?.title, updates.title, BROWSER_TAB_INFO_STRING_MAX.title);
  if (isTabError(title)) return title;
  const url = await parseChromeUrl(payload?.url, updates.url);
  if (isTabError(url)) return url;
  const faviconUrl = parseChromeField(payload?.faviconUrl, updates.faviconUrl, BROWSER_TAB_INFO_STRING_MAX.faviconUrl);
  if (isTabError(faviconUrl)) return faviconUrl;
  return { title, url, faviconUrl, updates };
}

function applyChromeUpdate(tab: TabState, input: ChromeUpdateInput): void {
  if (input.updates.title) tab.title = input.title ?? null;
  if (input.updates.url) tab.resumeUrl = input.url ?? null;
  if (input.updates.faviconUrl) tab.faviconUrl = input.faviconUrl ?? null;
}

function handleList(event: IpcMainInvokeEvent, payload: { threadId?: unknown; workspaceId?: unknown }): TabIpcResult<BrowserTabSet> {
  const context = resolveTabContext(event, payload);
  if ("ok" in context) return context;
  updateWorkspaceContext(context);
  return { ok: true, data: buildTabSet(context.session, context.threadId) };
}

async function handleOpen(event: IpcMainInvokeEvent, payload: { threadId?: unknown; workspaceId?: unknown; activate?: unknown; tabId?: unknown; initialAddress?: unknown }): Promise<TabIpcResult<{ tabId: string; tabs: BrowserTabSet }>> {
  const context = resolveTabContext(event, payload);
  if ("ok" in context) return context;
  const input = await parseOpenTabInput(payload);
  if ("ok" in input) return input;
  updateWorkspaceContext(context);
  return openTab(context, input);
}

function handleActivate(event: IpcMainInvokeEvent, payload: { threadId?: unknown; workspaceId?: unknown; tabId?: unknown }): TabIpcResult<BrowserTabSet> {
  const context = resolveTabIdContext(event, payload);
  if ("ok" in context) return context;
  updateWorkspaceContext(context);
  const set = ensureThreadTabSet(context.session, context.threadId);
  const tab = set.tabs.find((candidate) => candidate.id === context.tabId);
  if (!tab) return error("tab-not-found");
  if (set.activeTabId !== context.tabId) {
    set.activeTabId = context.tabId;
    if (context.threadId === context.session.lastPreviewThreadId) activateTab(context.session, tab);
  }
  const tabs = buildTabSet(context.session, context.threadId);
  sendTabsUpdated(context.win, tabs);
  logger.info("Preview: tab activated", { threadId: context.threadId, tabId: context.tabId });
  return { ok: true, data: tabs };
}

async function handleChromeUpdate(event: IpcMainInvokeEvent, payload: { threadId?: unknown; workspaceId?: unknown; tabId?: unknown; title?: unknown; url?: unknown; faviconUrl?: unknown }): Promise<TabIpcResult<BrowserTabSet>> {
  const context = resolveTabIdContext(event, payload);
  if ("ok" in context) return context;
  const input = await parseChromeUpdate(payload);
  if ("ok" in input) return input;
  updateWorkspaceContext(context);
  const tab = ensureThreadTabSet(context.session, context.threadId).tabs.find((candidate) => candidate.id === context.tabId);
  if (!tab) return error("tab-not-found");
  applyChromeUpdate(tab, input);
  return { ok: true, data: buildTabSet(context.session, context.threadId) };
}

function activateFallback(context: TabContext, tab: TabState): void {
  const set = ensureThreadTabSet(context.session, context.threadId);
  set.activeTabId = tab.id;
  if (context.threadId === context.session.lastPreviewThreadId) activateTab(context.session, tab);
}

function chooseRemainingActiveTab(context: TabContext, index: number, wasActive: boolean): void {
  const set = ensureThreadTabSet(context.session, context.threadId);
  if (!wasActive) return;
  const nextTab = set.tabs[Math.min(index, set.tabs.length - 1)]!;
  activateFallback(context, nextTab);
}

function createFallbackTab(context: TabContext): void {
  const set = ensureThreadTabSet(context.session, context.threadId);
  const fallback = createBlankTab(context.threadId, NodeCrypto.randomUUID());
  set.tabs.push(fallback);
  activateFallback(context, fallback);
}

function handleClose(event: IpcMainInvokeEvent, payload: { threadId?: unknown; workspaceId?: unknown; tabId?: unknown }): TabIpcResult<BrowserTabSet> {
  const context = resolveTabIdContext(event, payload);
  if ("ok" in context) return context;
  updateWorkspaceContext(context);
  const set = ensureThreadTabSet(context.session, context.threadId);
  const index = set.tabs.findIndex((tab) => tab.id === context.tabId);
  if (index === -1) return error("tab-not-found");
  const wasActive = set.activeTabId === context.tabId;
  set.tabs.splice(index, 1);
  if (set.tabs.length === 0) createFallbackTab(context);
  else chooseRemainingActiveTab(context, index, wasActive);
  const tabs = buildTabSet(context.session, context.threadId);
  sendTabsUpdated(context.win, tabs);
  logger.info("Preview: tab closed", { threadId: context.threadId, tabId: context.tabId, wasActive });
  return { ok: true, data: tabs };
}

function handleCloseScope(event: IpcMainInvokeEvent, payload: { threadId?: unknown; workspaceId?: unknown }): TabIpcResult<BrowserTabSet> {
  const context = resolveTabContext(event, payload);
  if ("ok" in context) return context;
  updateWorkspaceContext(context);
  context.session.tabsByThread.delete(previewTabScopeKey(context.workspaceId, context.threadId));
  if (context.session.lastPreviewThreadId === context.threadId) {
    context.session.lastPreviewThreadId = null;
    context.session.resumePreviewUrl = null;
  }
  const empty: BrowserTabSet = { threadId: context.threadId, activeTabId: null, tabs: [] };
  sendTabsUpdated(context.win, empty);
  logger.info("Preview: tab scope closed", { threadId: context.threadId });
  return { ok: true, data: empty };
}

/** Registers the Preview tab IPC handlers. */
export function registerTabHandlers(): void {
  ipcMain.handle("preview:tabs.list", handleList);
  ipcMain.handle("preview:tabs.open", handleOpen);
  ipcMain.handle("preview:tabs.activate", handleActivate);
  ipcMain.handle("preview:tabs.updateChrome", handleChromeUpdate);
  ipcMain.handle("preview:tabs.close", handleClose);
  ipcMain.handle("preview:tabs.closeScope", handleCloseScope);
}
