/**
 * Configures electron-updater to check GitHub Releases for new versions.
 * Checks once on launch, then on a configurable interval while running.
 *
 * Surfaces update lifecycle events to the renderer over IPC so the UI can
 * render an in-app banner and an "About" panel showing current state.
 * Also fires a native OS Notification when an update finishes downloading.
 *
 * Update behavior (release line, auto-download, auto-install, check interval)
 * is read from settings.json. Release line changes apply on the next check;
 * check interval still applies after restart (timer started at launch).
 */

import { autoUpdater } from "electron-updater";
import { app, BrowserWindow, Notification } from "electron";
import type { Event } from "electron";
import { readFileSync } from "fs";
import { join } from "path";
import { getMcodeDir } from "@mcode/shared";
import { SettingsSchema as BundledSettingsSchema } from "@mcode/contracts";

/** Use snapshot-provided schema when available (V8 snapshot pre-initializes Zod). */
const SettingsSchema =
  globalThis.__v8Snapshot?.contracts?.SettingsSchema ?? BundledSettingsSchema;

/**
 * Connectivity-class error tokens that should NOT surface as a red
 * "Update failed" banner. These are transient: WiFi reconnecting, VPN flap,
 * captive portal, IPv6 resolver hiccup, brief DNS outage. The next periodic
 * check will succeed without user intervention, so the right UX is to stay
 * quiet rather than alarm the user about a self-healing condition.
 *
 * Chromium `net::ERR_*` codes are emitted when the updater goes through
 * Electron's net module; POSIX `E*` codes are emitted by Node-level DNS/socket
 * failures (still possible inside electron-updater's HTTP layer on some paths).
 */
const TRANSIENT_NETWORK_TOKENS: readonly string[] = [
  "ERR_NAME_NOT_RESOLVED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NETWORK_CHANGED",
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_CONNECTION_ABORTED",
  "ERR_CONNECTION_CLOSED",
  "ERR_NETWORK_IO_SUSPENDED",
  "ERR_TIMED_OUT",
  "ERR_ADDRESS_UNREACHABLE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
];

/**
 * HTTP status codes that mean "the release host is briefly unavailable", not
 * "this update is broken". GitHub returns 502/503/504 when its edge is
 * overloaded and 429 when we poll too eagerly; 408 is a server-side read
 * timeout. All resolve on the next periodic check, so they should stay quiet
 * exactly like the connectivity tokens above. 4xx codes that indicate a real
 * problem (401 auth, 403 forbidden, 404 missing asset) are deliberately
 * excluded — those need to surface.
 */
const TRANSIENT_HTTP_STATUS: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

/**
 * Human-readable gateway phrases electron-updater includes in the error body
 * when the HTTP layer doesn't expose a numeric `statusCode`. Matched against
 * the message so a "504 Gateway Time-out" HTML response is recognized even
 * when it arrives as plain text. Kept narrow so "404" can't sneak in.
 */
const TRANSIENT_HTTP_PHRASES: readonly string[] = [
  "Gateway Time-out",
  "Gateway Timeout",
  "Bad Gateway",
  "Service Unavailable",
  "Too Many Requests",
];

/**
 * True for connectivity-class and transient-server failures that should be
 * logged but not surfaced to the user as an update error. Covers Chromium/POSIX
 * network tokens (`TRANSIENT_NETWORK_TOKENS`) and transient HTTP gateway
 * statuses (`TRANSIENT_HTTP_STATUS` / `TRANSIENT_HTTP_PHRASES`).
 */
export function isTransientNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && TRANSIENT_NETWORK_TOKENS.includes(code)) {
    return true;
  }
  const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
  if (typeof statusCode === "number" && TRANSIENT_HTTP_STATUS.has(statusCode)) {
    return true;
  }
  if (TRANSIENT_HTTP_PHRASES.some((phrase) => message.includes(phrase))) {
    return true;
  }
  return TRANSIENT_NETWORK_TOKENS.some((token) => message.includes(token));
}

/** Map from user-friendly interval names to milliseconds. */
const INTERVAL_MS_MAP: Record<string, number> = {
  "15min": 15 * 60 * 1000,
  "1hour": 60 * 60 * 1000,
  "4hours": 4 * 60 * 60 * 1000,
  "1day": 24 * 60 * 60 * 1000,
  never: Infinity,
};

interface UpdaterSettings {
  /** Stable follows tagged releases; nightly follows the CI prerelease channel. */
  releaseLine: "stable" | "nightly";
  autoDownload: boolean;
  autoInstallOnQuit: boolean;
  checkInterval: string;
}

/**
 * Maps persisted `updates.channel` to the electron-updater publish channel name.
 */
function releaseLineToUpdaterChannel(
  releaseLine: "stable" | "nightly",
): string {
  return releaseLine === "nightly" ? "nightly" : "latest";
}

/**
 * Apply both `autoUpdater.channel` and `autoUpdater.allowPrerelease` from the
 * persisted release line. Nightly per-build releases are GitHub prereleases,
 * so the updater must opt in via `allowPrerelease` to discover them.
 */
export function applyChannelConfig(releaseLine: "stable" | "nightly"): void {
  autoUpdater.channel = releaseLineToUpdaterChannel(releaseLine);
  autoUpdater.allowPrerelease = releaseLine === "nightly";
}

/** Shared promise so concurrent callers of applyReleaseLineSwitch await the same switch. */
let inFlightReleaseLineSwitch: Promise<UpdateStatus> | null = null;

/**
 * Switch the running updater to a new release line and trigger an immediate
 * check. When `allowDowngrade` is true, the underlying autoUpdater is
 * temporarily allowed to install an older build (used when the user has
 * confirmed a nightly → stable rollback). The flag is reset after the check
 * resolves so subsequent in-channel checks behave normally.
 *
 * **Precondition:** the caller MUST persist `updates.channel` to settings.json
 * BEFORE invoking this. `checkForUpdatesNow` internally re-reads settings and
 * re-applies the channel, so an unpersisted switch would be silently reverted
 * by the next periodic check.
 *
 * Concurrent calls share the same in-flight switch via `inFlightReleaseLineSwitch`.
 */
export async function applyReleaseLineSwitch(
  releaseLine: "stable" | "nightly",
  options: { allowDowngrade?: boolean } = {},
): Promise<UpdateStatus> {
  if (inFlightReleaseLineSwitch) {
    return inFlightReleaseLineSwitch;
  }
  inFlightReleaseLineSwitch = (async () => {
    applyChannelConfig(releaseLine);
    const previousAllowDowngrade = autoUpdater.allowDowngrade;
    if (options.allowDowngrade) {
      autoUpdater.allowDowngrade = true;
    }
    try {
      return await checkForUpdatesNow();
    } finally {
      autoUpdater.allowDowngrade = previousAllowDowngrade;
    }
  })();
  try {
    return await inFlightReleaseLineSwitch;
  } finally {
    inFlightReleaseLineSwitch = null;
  }
}

/**
 * Compare a major.minor.patch[-prerelease] string against another using semver
 * precedence rules (numeric segments compared numerically; prerelease present
 * is less than no prerelease at the same MAJOR.MINOR.PATCH).
 */
function semverGt(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [main, pre] = v.split("-", 2);
    const nums = main.split(".").map((n) => Number(n));
    return { nums, pre: pre ?? null };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    const ai = A.nums[i] ?? 0;
    const bi = B.nums[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  // Equal core. No-prerelease > has-prerelease.
  if (A.pre === null && B.pre !== null) return true;
  if (A.pre !== null && B.pre === null) return false;
  if (A.pre === null && B.pre === null) return false;
  // Both prerelease: compare identifiers per semver §11.4.
  const ap = (A.pre as string).split(".");
  const bp = (B.pre as string).split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return false;
    if (y === undefined) return true;
    const xn = Number(x);
    const yn = Number(y);
    const xIsNum = !Number.isNaN(xn);
    const yIsNum = !Number.isNaN(yn);
    if (xIsNum && yIsNum) {
      if (xn !== yn) return xn > yn;
    } else if (xIsNum) {
      return false; // numeric < alphanumeric
    } else if (yIsNum) {
      return true;
    } else if (x !== y) {
      return x > y;
    }
  }
  return false;
}

/**
 * True when switching `from` → `to` would require electron-updater to install
 * a version older than what is currently running. Used by the renderer's
 * channel-switch handler to decide whether to show a downgrade-confirmation
 * dialog before applying the new channel.
 */
export function isCrossChannelDowngrade(args: {
  from: "stable" | "nightly";
  to: "stable" | "nightly";
  currentVersion: string;
  latestStable: string | undefined;
}): boolean {
  if (args.from === args.to) return false;
  if (args.to !== "stable") return false;
  if (!args.latestStable) return false;
  return semverGt(args.currentVersion, args.latestStable);
}

/**
 * Applies the updater channel configuration (`channel` and `allowPrerelease`)
 * from user settings via `applyChannelConfig`, so checks target the stable or
 * nightly feed correctly.
 */
function applyUpdaterChannelFromSettings(settings: UpdaterSettings): void {
  applyChannelConfig(settings.releaseLine);
}

/**
 * Returns true when the running app version contains a `-nightly.` prerelease tag
 * (e.g. `0.11.1-nightly.20260518.3`). Used to auto-select the nightly update channel.
 */
function isNightlyBuild(): boolean {
  return app.getVersion().includes("-nightly.");
}

/** Read updater settings from settings.json; falls back to safe defaults if the file is missing or invalid. */
function loadUpdaterSettings(): UpdaterSettings {
  const defaults: UpdaterSettings = {
    releaseLine: isNightlyBuild() ? "nightly" : "stable",
    autoDownload: true,
    autoInstallOnQuit: true,
    checkInterval: "4hours",
  };
  try {
    const raw = readFileSync(join(getMcodeDir(), "settings.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const result = SettingsSchema().safeParse(parsed);
    if (result.success) {
      // Zod applies `.default("stable")` even when the user never set a
      // channel, so we check the raw JSON to tell "unset" from "explicit".
      // When no explicit channel is present, nightly builds default to
      // "nightly"; otherwise respect the user's explicit choice.
      const explicitChannel = parsed?.updates?.channel as string | undefined;
      const releaseLine = explicitChannel
        ? (result.data.updates.channel as "stable" | "nightly")
        : defaults.releaseLine;

      return {
        releaseLine,
        autoDownload:
          result.data.updates?.autoDownload ?? defaults.autoDownload,
        autoInstallOnQuit:
          result.data.updates?.autoInstallOnQuit ?? defaults.autoInstallOnQuit,
        checkInterval:
          result.data.updates?.checkInterval ?? defaults.checkInterval,
      };
    }
    console.warn(
      "[auto-updater] settings.json failed validation, using defaults",
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[auto-updater] settings.json could not be loaded, using defaults: ${message}`,
      );
    }
  }
  return defaults;
}

/** Convert a check-interval name to milliseconds, defaulting to 4 hours. */
function intervalToMs(interval: string): number {
  return INTERVAL_MS_MAP[interval] ?? 4 * 60 * 60 * 1000;
}

/** IPC push channel used to broadcast update status to the renderer. */
export const UPDATE_STATUS_CHANNEL = "app:update-status";

/** Discriminated union describing the current state of the update workflow. */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string }
  | { state: "not-available"; version: string }
  | { state: "downloading"; percent: number; bytesPerSecond?: number }
  | { state: "downloaded"; version: string; releaseNotes?: string }
  | { state: "error"; message: string };

let lastStatus: UpdateStatus = { state: "idle" };
let initialized = false;
let checkIntervalId: NodeJS.Timeout | null = null;
let initialCheckTimeoutId: NodeJS.Timeout | null = null;

/** Hook called before quitAndInstall to allow cleanup (e.g., stopping the server). */
let beforeInstallHook: (() => Promise<void>) | null = null;

/**
 * Skips redundant server-stop work once we have deferred quit to wait for teardown.
 * Matches our own before-quit handler on the synthetic second quit().
 */
let isCompletingStoppedServerQuit = false;
let installerQuitObserved = false;

/** Build the updater teardown hook from the server replacement dependency. */
export function createBeforeInstallHook(
  forceReplace: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    await forceReplace();
  };
}

/**
 * Register a callback that runs before every quitAndInstall.
 * Used by main.ts to inject server shutdown so the installer
 * does not hit locked files from the detached server process.
 */
export function setBeforeInstallHook(hook: () => Promise<void>): void {
  beforeInstallHook = hook;
}

/**
 * Stop the server (if hook registered), then run the installer.
 * All code paths that previously called autoUpdater.quitAndInstall()
 * must use this instead.
 */
async function quitAndInstallSafely(): Promise<boolean> {
  if (beforeInstallHook) {
    try {
      await beforeInstallHook();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        "[auto-updater] beforeInstallHook failed, cancelling install:",
        message,
      );
      broadcastStatus({
        state: "error",
        message: `Update installation blocked: ${message}`,
      });
      return false;
    }
  }
  installerQuitObserved = false;
  isCompletingStoppedServerQuit = true;
  try {
    const initiation = (
      autoUpdater.quitAndInstall as unknown as () => unknown
    )();
    if (initiation === false) {
      throw new Error("Update installer did not begin application shutdown");
    }
    if (
      initiation &&
      typeof (initiation as PromiseLike<unknown>).then === "function"
    ) {
      await initiation;
    }
  } catch (err) {
    isCompletingStoppedServerQuit = false;
    const message = err instanceof Error ? err.message : String(err);
    console.error("[auto-updater] quitAndInstall failed:", message);
    broadcastStatus({
      state: "error",
      message: `Update installation blocked: ${message}`,
    });
    return false;
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (!installerQuitObserved) {
    isCompletingStoppedServerQuit = false;
    const message = "Update installer did not begin application shutdown";
    console.error(`[auto-updater] ${message}`);
    broadcastStatus({
      state: "error",
      message: `Update installation blocked: ${message}`,
    });
    return false;
  }
  isCompletingStoppedServerQuit = false;
  return true;
}

/** Returns the most recently observed update status (for renderer hydration). */
export function getUpdateStatus(): UpdateStatus {
  return lastStatus;
}

/** Returns true once initAutoUpdater has run (and therefore in a packaged build). */
export function isUpdaterEnabled(): boolean {
  return initialized;
}

/** Broadcast a status change to all open windows. */
function broadcastStatus(status: UpdateStatus): void {
  lastStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(UPDATE_STATUS_CHANNEL, status);
    }
  }
}

/** Shared promise so concurrent callers wait for the active check to finish. */
let inFlightCheck: Promise<UpdateStatus> | null = null;

/**
 * Manually trigger a check for updates.
 * Safe to call from the renderer; resolves once the check completes.
 * Concurrent callers share the same in-flight check.
 */
export function checkForUpdatesNow(): Promise<UpdateStatus> {
  if (!initialized) {
    return Promise.resolve({
      state: "not-available",
      version: app.getVersion(),
    });
  }
  if (inFlightCheck) {
    return inFlightCheck;
  }
  inFlightCheck = (async () => {
    try {
      // Re-read settings so toggles and release line in the UI take effect
      // without an app restart.
      const settings = loadUpdaterSettings();
      applyUpdaterChannelFromSettings(settings);
      autoUpdater.autoDownload = settings.autoDownload;
      autoUpdater.autoInstallOnAppQuit = settings.autoInstallOnQuit;

      broadcastStatus({ state: "checking" });
      await autoUpdater.checkForUpdates();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcastStatus({ state: "error", message });
    } finally {
      inFlightCheck = null;
    }
    return lastStatus;
  })();
  return inFlightCheck;
}

/** Quit and install a downloaded update. Returns false in dev or if nothing is downloaded. */
export async function installUpdate(): Promise<boolean> {
  if (!app.isPackaged) return false;
  if (lastStatus.state !== "downloaded") return false;
  return quitAndInstallSafely();
}

/**
 * Trigger a manual download of a discovered update.
 * Used when autoDownload is off and the user clicks "Download" in the banner.
 */
export async function downloadUpdate(): Promise<void> {
  if (!initialized) return;
  if (lastStatus.state !== "available") return;
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcastStatus({ state: "error", message });
  }
}

/**
 * When `electron-updater` will install on quit, Electron may exit while the detached server
 * still holds DLLs inside the install prefix. Deferred quit frees those handles first.
 */
function onBeforeQuitForPendingInstall(event: Event): void {
  if (isCompletingStoppedServerQuit) {
    installerQuitObserved = true;
    return;
  }
  if (!app.isPackaged) return;
  if (!initialized) return;
  const { autoInstallOnQuit } = loadUpdaterSettings();
  if (!autoInstallOnQuit || lastStatus.state !== "downloaded") return;

  event.preventDefault();
  installerQuitObserved = false;
  isCompletingStoppedServerQuit = true;
  void (async () => {
    try {
      if (beforeInstallHook) await beforeInstallHook();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        "[auto-updater] server stop failed before silent install on quit:",
        message,
      );
      isCompletingStoppedServerQuit = false;
      broadcastStatus({
        state: "error",
        message: `Update installation blocked: ${message}`,
      });
      return;
    }
    try {
      app.quit();
    } catch (err) {
      isCompletingStoppedServerQuit = false;
      const message = err instanceof Error ? err.message : String(err);
      console.error("[auto-updater] deferred app quit failed:", message);
      broadcastStatus({
        state: "error",
        message: `Update installation blocked: ${message}`,
      });
      return;
    }
    if (!installerQuitObserved) {
      isCompletingStoppedServerQuit = false;
      const message = "Update installer did not begin application shutdown";
      console.error(`[auto-updater] ${message}`);
      broadcastStatus({
        state: "error",
        message: `Update installation blocked: ${message}`,
      });
      return;
    }
    isCompletingStoppedServerQuit = false;
  })();
}

/**
 * Initializes auto-update checks. Call once after app "ready" fires.
 * No-op in dev (no packaged app to update).
 */
export function initAutoUpdater(): void {
  if (initialized) return;
  initialized = true;
  app.on("before-quit", onBeforeQuitForPendingInstall);

  // In dev, force electron-updater to read dev-app-update.yml so we can
  // test the check/download flow without a packaged build.
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
  }

  autoUpdater.allowDowngrade = false;

  const updaterSettings = loadUpdaterSettings();
  applyUpdaterChannelFromSettings(updaterSettings);
  autoUpdater.autoDownload = updaterSettings.autoDownload;
  autoUpdater.autoInstallOnAppQuit = updaterSettings.autoInstallOnQuit;
  const { checkInterval } = updaterSettings;

  autoUpdater.on("checking-for-update", () => {
    broadcastStatus({ state: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    broadcastStatus({
      state: "available",
      version: info.version,
      releaseNotes: stringifyReleaseNotes(info.releaseNotes),
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    broadcastStatus({
      state: "not-available",
      version: info?.version ?? app.getVersion(),
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    broadcastStatus({
      state: "downloading",
      percent: Math.round(progress.percent ?? 0),
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    const releaseNotes = stringifyReleaseNotes(info.releaseNotes);
    broadcastStatus({
      state: "downloaded",
      version: info.version,
      releaseNotes,
    });

    // Fire a passive OS notification so the user is aware even when Mcode is
    // backgrounded. Clicking it focuses the window, where the in-app update
    // indicator offers the restart affordance. We deliberately do NOT open a
    // native restart dialog — the restart choice lives in the app chrome.
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: "Mcode update ready",
        body: `Version ${info.version} has been downloaded. Restart to install.`,
      });
      notification.on("click", () => focusMainWindow());
      notification.show();
    }
  });

  autoUpdater.on("error", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (isTransientNetworkError(err)) {
      // Connectivity blips (DNS failure, captive portal, offline-at-launch)
      // resolve themselves on the next periodic check. Log for diagnostics but
      // do not flip the renderer to an error toast — see UpdateIndicator.tsx.
      console.warn(
        "[auto-updater] Transient network failure, will retry:",
        message,
      );
      broadcastStatus({ state: "idle" });
      return;
    }
    console.error("[auto-updater] Error checking for updates:", message);
    broadcastStatus({ state: "error", message });
  });

  // Initial check shortly after launch (give the window time to load)
  initialCheckTimeoutId = setTimeout(() => {
    void checkForUpdatesNow();
  }, 10_000);

  // Periodic checks using the configured interval
  const intervalMs = intervalToMs(checkInterval);
  if (isFinite(intervalMs)) {
    checkIntervalId = setInterval(() => {
      void checkForUpdatesNow();
    }, intervalMs);
  }
}

/**
 * Clean up timers and listeners when the app is shutting down.
 * Call from app "quit" or "will-quit" event.
 */
export function cleanupAutoUpdater(): void {
  app.removeListener("before-quit", onBeforeQuitForPendingInstall);
  isCompletingStoppedServerQuit = false;
  installerQuitObserved = false;
  if (initialCheckTimeoutId) {
    clearTimeout(initialCheckTimeoutId);
    initialCheckTimeoutId = null;
  }
  if (checkIntervalId) {
    clearInterval(checkIntervalId);
    checkIntervalId = null;
  }
  autoUpdater.removeAllListeners();
}

/** Bring the main window to the foreground (restoring it if minimized). */
function focusMainWindow(): void {
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Normalize release notes into a plain string. electron-updater can return
 * either a string, an array of {version, note} entries, or null.
 */
function stringifyReleaseNotes(
  notes:
    string | Array<{ version: string; note: string | null }> | null | undefined,
): string | undefined {
  if (!notes) return undefined;
  if (typeof notes === "string") return notes;
  return notes
    .map((entry) => entry.note?.trim())
    .filter((note): note is string => Boolean(note))
    .join("\n\n");
}
