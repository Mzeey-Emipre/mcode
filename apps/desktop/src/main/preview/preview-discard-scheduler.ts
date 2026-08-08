/**
 * Per-session memory-saver scheduler (ADR 0002). Runs the pure
 * `selectTabsToDiscard` policy on a sweep interval while the panel is visible
 * and on a single delayed timer after the panel hides, then disposes the
 * returned tabs' renderers after persisting each tab's validated URL.
 *
 * Hysteresis: the hidden timer is cancelled when the panel reappears, the
 * direct mitigation for the #454 ResizeObserver `visible`-flag flap.
 */

import { BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMcodeDir, logger } from "@mcode/shared";
import { SettingsSchema as BundledSettingsSchema } from "@mcode/contracts";
import {
  selectTabsToDiscard,
  type WarmTabRef,
  type DiscardConfig,
} from "./select-tabs-to-discard.js";
import {
  emitTabsUpdated,
  getThreadTabSet,
  isAllowedPreviewUrl,
  type PreviewSession,
  type TabState,
  type ThreadTabSet,
} from "./preview-session.js";
import {
  findAdoptedWebContentsForWindow,
  requestRendererSurfaceDiscard,
} from "./preview-webview-adopt.js";
import { validateResumeUrl } from "./preview-local-file.js";
import { bumpPerf, setPerf } from "./preview-perf.js";

/** Mirror server-manager's snapshot-aware schema resolution for packaged builds. */
const SettingsSchema =
  globalThis.__v8Snapshot?.contracts?.SettingsSchema ?? BundledSettingsSchema;

/** Fallback thresholds when settings.json is missing or unparseable (matches schema defaults). */
const DEFAULT_CONFIG: DiscardConfig = {
  maxWarm: 3,
  bgIdleMs: 300_000,
  hiddenIdleMs: 60_000,
};

/** Floor for the visible-panel sweep interval so we never spin too hot. */
const SWEEP_INTERVAL_FLOOR_MS = 15_000;

/** Reads `preview.memorySaver.*` from settings.json, falling back to defaults. */
export function readMemorySaverConfig(): DiscardConfig {
  try {
    const raw = readFileSync(join(getMcodeDir(), "settings.json"), "utf-8");
    const parsed = SettingsSchema().safeParse(JSON.parse(raw));
    if (parsed.success) {
      const ms = parsed.data.preview.memorySaver;
      return { maxWarm: ms.maxWarm, bgIdleMs: ms.bgIdleMs, hiddenIdleMs: ms.hiddenIdleMs };
    }
  } catch {
    /* missing / unreadable / invalid JSON -> defaults */
  }
  return DEFAULT_CONFIG;
}

/** Enumerates every warm tab across all threads in the session. */
function collectWarmTabs(s: PreviewSession): WarmTabRef[] {
  const out: WarmTabRef[] = [];
  for (const set of s.tabsByThread.values()) {
    for (const tab of set.tabs) {
      if (tab.rendererSurfaceGeneration != null) {
        out.push({ tabId: tab.id, threadId: tab.threadId, lastActiveAt: tab.lastActiveAt });
      }
    }
  }
  return out;
}

/** Active tab id of the active preview thread, or null. */
function activeTabIdOf(s: PreviewSession): string | null {
  if (!s.lastPreviewThreadId) return null;
  return getThreadTabSet(s, s.lastPreviewThreadId)?.activeTabId ?? null;
}

/** Locates a tab by id across all threads. */
function locateTab(s: PreviewSession, tabId: string): { set: ThreadTabSet; tab: TabState } | null {
  for (const set of s.tabsByThread.values()) {
    const tab = set.tabs.find((t) => t.id === tabId);
    if (tab) return { set, tab };
  }
  return null;
}

/**
 * Runs the policy once and disposes the selected tabs. Persists each tab's
 * validated live URL before killing its renderer so re-warm reloads the page.
 */
export async function runDiscardSweep(
  win: BrowserWindow,
  s: PreviewSession,
  visible: boolean,
  config: DiscardConfig,
): Promise<void> {
  if (win.isDestroyed()) return;
  if (s.discardSweepInProgress) return;
  s.discardSweepInProgress = true;
  try {
    const warm = collectWarmTabs(s);
    setPerf("warmInactiveRuntimeCount", warm.length);
    if (warm.length === 0) return;

    const ids = selectTabsToDiscard(
      warm,
      s.lastPreviewThreadId,
      activeTabIdOf(s),
      visible,
      Date.now(),
      config,
    );
    if (ids.length === 0) return;

    let activeThreadTouched = false;
    for (const id of ids) {
      const located = locateTab(s, id);
      if (!located) continue;
      const { tab } = located;

      // Persist the validated current URL before disposing (ADR 0002).
      const rendererGuest = tab.rendererSurfaceGeneration == null
        ? null
        : findAdoptedWebContentsForWindow(
            win.id,
            tab.threadId,
            tab.id,
            tab.rendererSurfaceGeneration,
          );
      if (rendererGuest) {
        try {
          const live = rendererGuest.getURL();
          const safe = await validateResumeUrl(isAllowedPreviewUrl(live) ? live : null);
          if (safe) tab.resumeUrl = safe;
        } catch {
          /* guest may be tearing down; keep the last known resumeUrl */
        }
      }
      if (win.isDestroyed()) return;

      requestRendererSurfaceDiscard(win, s.workspaceId ?? tab.threadId, tab.threadId, tab.id);
    }

    setPerf("warmInactiveRuntimeCount", collectWarmTabs(s).length);
    if (activeThreadTouched && s.lastPreviewThreadId) {
      emitTabsUpdated(win, s, s.lastPreviewThreadId);
    }
  } finally {
    s.discardSweepInProgress = false;
  }
}

/**
 * Panel became visible: cancel any pending hidden-discard (hysteresis) and
 * start the background-idle sweep if it is not already running. The sweep
 * interval is fixed at start time, so a `bgIdleMs` settings change only takes
 * effect after the panel is next hidden and reshown.
 */
export function onPreviewVisible(win: BrowserWindow, s: PreviewSession): void {
  if (s.discardHiddenTimer) {
    clearTimeout(s.discardHiddenTimer);
    s.discardHiddenTimer = null;
    bumpPerf("inactiveTabSuspendCancelled");
  }
  if (s.discardSweepTimer) return;
  const cfg = readMemorySaverConfig();
  const interval = Math.max(SWEEP_INTERVAL_FLOOR_MS, Math.floor(cfg.bgIdleMs / 2));
  s.discardSweepTimer = setInterval(() => {
    void runDiscardSweep(win, s, true, readMemorySaverConfig());
  }, interval);
  bumpPerf("inactiveTabSuspendScheduled");
}

/**
 * Panel hidden: stop the sweep and schedule a single delayed trim. Stamps the
 * active tab fresh so the tab the user just left survives as part of the MRU
 * working set. The timer is cancelled by `onPreviewVisible` if the panel
 * returns within `hiddenIdleMs` (the #454 flap mitigation).
 */
export function onPreviewHidden(win: BrowserWindow, s: PreviewSession): void {
  if (s.discardSweepTimer) {
    clearInterval(s.discardSweepTimer);
    s.discardSweepTimer = null;
  }
  if (s.discardHiddenTimer) return;

  const activeId = activeTabIdOf(s);
  if (activeId) {
    const located = locateTab(s, activeId);
    if (located) located.tab.lastActiveAt = Date.now();
  }

  const cfg = readMemorySaverConfig();
  s.discardHiddenTimer = setTimeout(() => {
    s.discardHiddenTimer = null;
    void runDiscardSweep(win, s, false, readMemorySaverConfig());
  }, cfg.hiddenIdleMs);
  bumpPerf("inactiveTabSuspendScheduled");
  logger.info("Preview: hidden discard scheduled", { hiddenIdleMs: cfg.hiddenIdleMs });
}
