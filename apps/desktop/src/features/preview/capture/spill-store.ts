/**
 * Browser capture spill file management: persist, prune, and release large
 * capture payloads stored under the Mcode app data directory.
 */

import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, normalize, resolve } from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import {
  isBrowserCaptureSpillAppDataPath,
  type McodeBrowserCaptureV2,
} from "@mcode/contracts";
import { getMcodeDir, spillWorkspaceDirSegment } from "@mcode/shared";

/** Delete spill files older than this under `browser-capture-spill/` in the Mcode app data dir. */
const SPILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum time between full-tree spill prune walks so capture stays off the hot path. */
const SPILL_PRUNE_MIN_INTERVAL_MS = 30 * 60 * 1000;

/** Debounce after the last spill write before attempting a prune pass. */
const SPILL_PRUNE_DEBOUNCE_MS = 30_000;

/** One delayed prune shortly after startup so old JSON is collected even without new captures. */
const SPILL_PRUNE_STARTUP_DELAY_MS = 120_000;

let spillPruneDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastGlobalSpillPruneAt = 0;

/**
 * Resolves a relative spill app-data path to its validated absolute filesystem path.
 * Returns null if the path is not a valid browser-capture-spill path or attempts traversal.
 */
function resolveValidatedSpillAbsolutePath(rel: string): string | null {
  if (!isBrowserCaptureSpillAppDataPath(rel)) return null;
  const segments = rel.split("/");
  if (segments.length !== 3 || segments[0] !== "browser-capture-spill") return null;
  const [, wsSeg, file] = segments;
  const base = resolve(getMcodeDir(), "browser-capture-spill", wsSeg);
  const abs = resolve(base, file);
  if (normalize(dirname(abs)) !== normalize(base)) return null;
  return abs;
}

/**
 * Walks the spill root directory and deletes JSON files older than SPILL_MAX_AGE_MS.
 */
async function pruneStaleBrowserCaptureSpills(rootDir: string): Promise<void> {
  try {
    const now = Date.now();
    const top = await readdir(rootDir, { withFileTypes: true });
    for (const ent of top) {
      if (!ent.isDirectory()) continue;
      const dir = join(rootDir, ent.name);
      const files = await readdir(dir);
      for (const name of files) {
        if (!name.endsWith(".json")) continue;
        const p = join(dir, name);
        const st = await stat(p);
        if (now - st.mtimeMs > SPILL_MAX_AGE_MS) {
          await unlink(p).catch(() => {});
        }
      }
    }
  } catch {
    /* missing dir or race */
  }
}

/**
 * Debounces and throttles global spill pruning so `persistBrowserCaptureSpill` does not scan
 * every workspace directory on every capture (noticeable on slow storage).
 */
function scheduleGlobalBrowserCaptureSpillPrune(): void {
  if (spillPruneDebounceTimer) clearTimeout(spillPruneDebounceTimer);
  spillPruneDebounceTimer = setTimeout(() => {
    spillPruneDebounceTimer = null;
    const now = Date.now();
    if (now - lastGlobalSpillPruneAt < SPILL_PRUNE_MIN_INTERVAL_MS) return;
    lastGlobalSpillPruneAt = now;
    void pruneStaleBrowserCaptureSpills(join(getMcodeDir(), "browser-capture-spill"));
  }, SPILL_PRUNE_DEBOUNCE_MS);
}

/**
 * Writes full redacted excerpts under the Mcode app data directory so production and dev use
 * ~/.mcode / ~/.mcode-dev rather than the project tree or `.mcode-local/`.
 */
export async function persistBrowserCaptureSpill(
  workspaceId: string,
  redacted: McodeBrowserCaptureV2,
): Promise<{ appDataPath: string; absolutePath: string } | null> {
  const wid = workspaceId.trim();
  if (!wid) return null;
  const sub = spillWorkspaceDirSegment(wid);
  const id = randomUUID();
  const fileName = `${id}.json`;
  const spillRoot = join(getMcodeDir(), "browser-capture-spill", sub);
  await mkdir(spillRoot, { recursive: true });
  const fields: Record<string, string> = {};
  if (redacted.htmlExcerpt) fields.htmlExcerpt = redacted.htmlExcerpt;
  if (redacted.visibleTextExcerpt) fields.visibleTextExcerpt = redacted.visibleTextExcerpt;
  if (redacted.headingOutline) fields.headingOutline = redacted.headingOutline;
  if (redacted.interactiveOutlineExcerpt) {
    fields.interactiveOutlineExcerpt = redacted.interactiveOutlineExcerpt;
  }
  if (redacted.consoleTail) fields.consoleTail = redacted.consoleTail;
  const body = {
    schemaVersion: 1 as const,
    capturedAt: redacted.capturedAt,
    pageUrl: redacted.pageUrl,
    pageTitle: redacted.pageTitle,
    fields,
  };
  const absolutePath = join(spillRoot, fileName);
  await writeFile(absolutePath, JSON.stringify(body), "utf8");
  scheduleGlobalBrowserCaptureSpillPrune();
  const appDataPath = `browser-capture-spill/${sub}/${fileName}`;
  return { appDataPath, absolutePath };
}

/**
 * Registers the `preview:release-browser-capture-spill` IPC handler and schedules
 * the startup prune pass. Call once at app startup.
 */
export function registerSpillHandlers(): void {
  ipcMain.handle("preview:release-browser-capture-spill", async (_event, relPaths: unknown) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    const list = Array.isArray(relPaths) ? relPaths : [];
    for (const p of list) {
      if (typeof p !== "string") continue;
      const abs = resolveValidatedSpillAbsolutePath(p);
      if (abs) await unlink(abs).catch(() => {});
    }
  });

  setTimeout(() => {
    lastGlobalSpillPruneAt = Date.now();
    void pruneStaleBrowserCaptureSpills(join(getMcodeDir(), "browser-capture-spill"));
  }, SPILL_PRUNE_STARTUP_DELAY_MS);
}
