import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/**
 * Max lengths for {@link BrowserTabInfo} string fields. Enforced at IPC boundaries
 * so a runaway page title or huge favicon URL cannot blow up renderer state.
 */
export const BROWSER_TAB_INFO_STRING_MAX = {
  id: 64,
  threadId: 128,
  title: 240,
  url: 4096,
  faviconUrl: 4096,
} as const;

/** Rendering surfaces supported by the desktop preview tab host. */
export const PREVIEW_RENDERING_HOSTS = ["webContentsView", "webview"] as const;

/** Surface that owns a preview tab's live page. */
export type PreviewRenderingHost = (typeof PREVIEW_RENDERING_HOSTS)[number];

/** Stable, opaque identifier for a tab. Generated host-side on create. */
export const BrowserTabIdSchema = lazySchema(() =>
  z.string().min(1).max(BROWSER_TAB_INFO_STRING_MAX.id),
);
export type BrowserTabId = z.infer<ReturnType<typeof BrowserTabIdSchema>>;

/**
 * Public, serializable view of a single tab inside the in-app browser.
 * Mirrors the host-side `TabState` minus the BrowserView reference.
 */
export const BrowserTabInfoSchema = lazySchema(() =>
  z.object({
    id: z.string().min(1).max(BROWSER_TAB_INFO_STRING_MAX.id),
    threadId: z.string().min(1).max(BROWSER_TAB_INFO_STRING_MAX.threadId),
    title: z.string().max(BROWSER_TAB_INFO_STRING_MAX.title).nullable(),
    url: z.string().max(BROWSER_TAB_INFO_STRING_MAX.url).nullable(),
    faviconUrl: z.string().max(BROWSER_TAB_INFO_STRING_MAX.faviconUrl).nullable(),
    /** True when the tab has a live BrowserView attached; false for evicted/cold tabs. */
    warm: z.boolean(),
    /** True when this is the tab whose BrowserView is mounted in the window. */
    active: z.boolean(),
  }),
);
export type BrowserTabInfo = z.infer<ReturnType<typeof BrowserTabInfoSchema>>;

/**
 * Snapshot of a thread's tab set returned by `preview:tabs.list` and after every
 * tab mutation IPC. The renderer treats this as the source of truth and
 * reconciles its Zustand store against it.
 */
export const BrowserTabSetSchema = lazySchema(() =>
  z.object({
    threadId: z.string().min(1).max(BROWSER_TAB_INFO_STRING_MAX.threadId),
    activeTabId: z.string().min(1).max(BROWSER_TAB_INFO_STRING_MAX.id).nullable(),
    tabs: z.array(BrowserTabInfoSchema()),
  }),
);
export type BrowserTabSet = z.infer<ReturnType<typeof BrowserTabSetSchema>>;

/**
 * Hot-path counters for the embedded browser. Mirrors dpcode's
 * `BrowserPerformanceSnapshot.counters` so the dev HUD and any future eval
 * harness see the same shape across both projects.
 */
export const BrowserPerfCountersSchema = lazySchema(() =>
  z.object({
    setPanelBoundsCalls: z.number().int().nonnegative(),
    setPanelBoundsNoopSkips: z.number().int().nonnegative(),
    setPanelBoundsViewportUpdates: z.number().int().nonnegative(),
    stateEmitCalls: z.number().int().nonnegative(),
    stateEmitSkips: z.number().int().nonnegative(),
    stateCloneCount: z.number().int().nonnegative(),
    runtimeSyncQueueFlushes: z.number().int().nonnegative(),
    syncRuntimeStateCalls: z.number().int().nonnegative(),
    inactiveTabSuspendScheduled: z.number().int().nonnegative(),
    inactiveTabSuspendCancelled: z.number().int().nonnegative(),
    inactiveTabBudgetEvictions: z.number().int().nonnegative(),
    warmInactiveRuntimeCount: z.number().int().nonnegative(),
  }),
);
export type BrowserPerfCounters = z.infer<ReturnType<typeof BrowserPerfCountersSchema>>;
