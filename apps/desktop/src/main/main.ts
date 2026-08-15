const STARTUP_TIME = performance.now();

/**
 * Electron main process entry point.
 * Thin shell that spawns the Mcode server as a child process and
 * bridges native OS features (dialogs, clipboard, shell, editors)
 * to the renderer via IPC.
 */

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  session,
  shell,
} from "electron";
import { existsSync, createReadStream } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { isAbsolute, join } from "path";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { getLogPath, getMcodeDir, getRecentLogs, logger } from "@mcode/shared";
import {
  getExtension as bundledGetExtension,
  isMcodeWorkspacePreviewUrl,
} from "@mcode/contracts";

/** Use snapshot-provided module when available (V8 snapshot skips re-init). */
const getExtension =
  globalThis.__v8Snapshot?.contracts?.getExtension ?? bundledGetExtension;

import { openInRegistry } from "./open-in/index.js";
import { ServerManager } from "./server-manager.js";
import { ServerCrashRecovery } from "./server-crash-recovery.js";
import { startIpcRelay } from "./ipc-relay.js";
import {
  applyReleaseLineSwitch,
  checkForUpdatesNow,
  downloadUpdate,
  getUpdateStatus,
  initAutoUpdater,
  installUpdate,
  cleanupAutoUpdater,
  createBeforeInstallHook,
  setBeforeInstallHook,
} from "./auto-updater.js";
import { setupSpellcheck } from "./spellcheck.js";
import {
  registerPreviewBrowserHandlers,
  disposeBrowserAutomationForWindow,
  disposePreviewForWindow,
  resolveMcodeWorkspacePreviewUrl,
  hardenPreviewWebviewAttachment,
  resolvePreviewGuestPreloadPath,
} from "../features/preview/index.js";
import { isDesktopDev } from "./is-desktop-dev.js";
import { shouldSetDockIcon } from "./dock-icon.js";
import { shouldPrintVersion } from "./cli-args.js";
import {
  buildTerminalReleaseTestRendererArguments,
  isTerminalReleaseTestEnabled,
} from "../features/terminal/release-test-capability.js";

// Isolate dev's Electron userData (cache, cookies, localStorage, IndexedDB)
// from the installed prod build. Without this, both share %APPDATA%/Mcode/
// and the running prod instance holds locks on the disk cache, which makes
// dev fail to start with "Unable to move the cache: Access is denied" and
// a black renderer. Server data is already split via getMcodeDir(), but
// Electron's userData is derived from app.getName() and must be set here,
// before app.whenReady() and any other path-dependent call.
if (!app.isPackaged) {
  const agentUserDataDir =
    process.env.MCODE_AGENT_RUNTIME === "1"
      ? process.env.MCODE_ELECTRON_USER_DATA_DIR?.trim()
      : undefined;
  app.setPath(
    "userData",
    agentUserDataDir || join(app.getPath("appData"), "Mcode-Dev"),
  );
}

if (shouldPrintVersion(process.argv)) {
  console.log(app.getVersion());
  app.exit(0);
}

// ---------------------------------------------------------------------------
// Attachment protocol constants
// ---------------------------------------------------------------------------

const VALID_ATTACHMENT_ID = /^[a-f0-9-]+$/;

const MIME_MAP: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
};

// ---------------------------------------------------------------------------
// External URL helper
// ---------------------------------------------------------------------------

/** Protocols that may be opened in the user's default browser. */
const EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

/** Open a URL in the system browser if its protocol is allowed. */
function openIfAllowed(url: string): void {
  try {
    const parsed = new URL(url);
    if (EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
      shell.openExternal(parsed.href).catch((err: unknown) => {
        console.error(
          `[openIfAllowed] Failed to open ${parsed.protocol} URL: ${parsed.href}`,
          err,
        );
      });
    }
  } catch {
    // Invalid URL, ignore
  }
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

const APP_ID = "com.mzeey.mcode";
type HardwareAccelerationMode = "disabled" | "default";

/** Selects the test-only acceleration mode without changing the product default. */
export function resolveHardwareAccelerationMode(
  env: Readonly<Record<string, string | undefined>>,
): HardwareAccelerationMode {
  if (env.MCODE_FRONTEND_PERFORMANCE_MODE !== "production") {
    return "disabled";
  }
  const requested = env.MCODE_FRONTEND_PERFORMANCE_ACCELERATION_MODE ?? "disabled";
  if (requested !== "disabled" && requested !== "default") {
    throw new Error(
      "MCODE_FRONTEND_PERFORMANCE_ACCELERATION_MODE must be disabled or default",
    );
  }
  return requested;
}

const HARDWARE_ACCELERATION_MODE = resolveHardwareAccelerationMode(process.env);
let mainWindow: BrowserWindow | null = null;

/** Channel available only to the maintained frontend performance runner. */
export const FRONTEND_PERFORMANCE_METRICS_CHANNEL = "performance:get-app-metrics";
export const FRONTEND_PERFORMANCE_QUIT_CHANNEL = "performance:quit";

function isFrontendPerformanceRun(): boolean {
  return (
    process.env.MCODE_FRONTEND_PERFORMANCE_MODE === "profiling" ||
    process.env.MCODE_FRONTEND_PERFORMANCE_MODE === "production"
  );
}

function finiteMetric(value: number | undefined): number | null {
  return Number.isFinite(value) ? value! : null;
}

/** Returns bounded Electron process metrics for an authorized performance run. */
export function getFrontendPerformanceMetrics(): {
  readonly packaged: boolean;
  readonly accelerationMode: HardwareAccelerationMode;
  readonly gpuFeatureStatus: ReturnType<typeof app.getGPUFeatureStatus>;
  readonly devToolsOpen: boolean;
  readonly processes: readonly {
    readonly pid: number;
    readonly creationTime: number;
    readonly type: string;
    readonly cpuPercent: number | null;
    readonly memory: {
      readonly workingSetSizeKiB: number | null;
      readonly peakWorkingSetSizeKiB: number | null;
      readonly privateBytesKiB: number | null;
    } | null;
  }[];
} {
  return {
    packaged: app.isPackaged,
    accelerationMode: HARDWARE_ACCELERATION_MODE,
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    devToolsOpen: mainWindow?.webContents.isDevToolsOpened() ?? false,
    processes: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      creationTime: metric.creationTime,
      type: metric.type,
      cpuPercent: finiteMetric(metric.cpu?.percentCPUUsage),
      memory: metric.memory
        ? {
            workingSetSizeKiB: finiteMetric(metric.memory.workingSetSize),
            peakWorkingSetSizeKiB: finiteMetric(metric.memory.peakWorkingSetSize),
            privateBytesKiB: finiteMetric(metric.memory.privateBytes),
          }
        : null,
    })),
  };
}

/** Channel used by the renderer crash boundary to report local diagnostics. */
export const RENDERER_CRASH_REPORT_CHANNEL = "renderer:crash-report";
const RENDERER_CRASH_COMPONENT_STACK_MAX_LENGTH = 16 * 1024;
const RENDERER_CRASH_COMPONENT_FRAME_MAX_COUNT = 32;
const RENDERER_CRASH_COMPONENT_FRAME_MAX_LENGTH = 128;
const RENDERER_CRASH_REPORT_LIMIT = 3;
const RENDERER_CRASH_REPORT_WINDOW_MS = 60_000;
const RENDERER_CRASH_ERROR_NAMES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "DOMException",
]);
const rendererCrashReportTimestamps = new Map<number, number[]>();

/** Safe renderer crash report payload accepted at the desktop IPC boundary. */
export interface RendererCrashReportPayload {
  readonly errorName: string;
  readonly componentStack: string;
  readonly componentStackTruncated: boolean;
}

/** Extract bounded React frame names, dropping renderer-controlled locations and text. */
function normalizeRendererComponentStack(value: string): {
  componentStack: string;
  componentStackTruncated: boolean;
} | null {
  const framePattern = /^\s*at\s+([A-Za-z_$][A-Za-z0-9_$]*(?:[.$][A-Za-z_$][A-Za-z0-9_$]*){0,7})\s*(?:\(|$)/;
  const frames: string[] = [];
  for (const line of value.replace(/\r\n?/g, "\n").split("\n")) {
    const frameName = framePattern.exec(line)?.[1];
    if (!frameName || frameName.length > RENDERER_CRASH_COMPONENT_FRAME_MAX_LENGTH) {
      continue;
    }
    frames.push(frameName);
  }
  if (frames.length === 0) return null;
  const componentStackTruncated = frames.length > RENDERER_CRASH_COMPONENT_FRAME_MAX_COUNT;
  return {
    componentStack: frames
      .slice(0, RENDERER_CRASH_COMPONENT_FRAME_MAX_COUNT)
      .join("\n"),
    componentStackTruncated,
  };
}

/** Validate and normalize untrusted renderer crash diagnostics. */
export function normalizeRendererCrashReport(
  payload: unknown,
): RendererCrashReportPayload | null {
  if (payload === null || typeof payload !== "object") return null;
  try {
    const record = payload as Record<string, unknown>;
    if (
      Object.getPrototypeOf(record) !== Object.prototype ||
      Object.keys(record).length !== 2 ||
      typeof record.errorName !== "string" ||
      typeof record.componentStack !== "string"
    ) {
      return null;
    }
    if (
      record.componentStack.length > RENDERER_CRASH_COMPONENT_STACK_MAX_LENGTH
    ) {
      return null;
    }
    if (record.componentStack.length > RENDERER_CRASH_COMPONENT_STACK_MAX_LENGTH) {
      return null;
    }
    const normalizedStack = normalizeRendererComponentStack(record.componentStack);
    if (!normalizedStack) return null;
    return {
      errorName: RENDERER_CRASH_ERROR_NAMES.has(record.errorName)
        ? record.errorName
        : "Error",
      ...normalizedStack,
    };
  } catch {
    return null;
  }
}

/** Accept an authorized, rate-limited renderer crash report and write safe fields. */
export function handleRendererCrashReport(
  event: { sender: { id: number } },
  payload: unknown,
  authorizedSender: unknown = mainWindow?.webContents,
): void {
  if (event.sender !== authorizedSender) return;
  const normalized = normalizeRendererCrashReport(payload);
  if (!normalized) return;
  const now = Date.now();
  const recent = (rendererCrashReportTimestamps.get(event.sender.id) ?? []).filter(
    (timestamp) => now - timestamp < RENDERER_CRASH_REPORT_WINDOW_MS,
  );
  if (recent.length >= RENDERER_CRASH_REPORT_LIMIT) return;
  recent.push(now);
  rendererCrashReportTimestamps.set(event.sender.id, recent);
  logger.info("Renderer crash report", {
    errorName: normalized.errorName,
    componentStack: normalized.componentStack,
    componentStackTruncated: normalized.componentStackTruncated,
  });
}
const serverManager = new ServerManager();
const serverCrashRecovery = new ServerCrashRecovery({
  restart: () => serverManager.restart(),
  notifyRecovered: (code) => showServerRecoveredNotification(code),
  showError: (code) => showServerCrashDialog(code),
});

/** Returns the app icon path used for dev windows and packaged resources. */
function getWindowIconPath(): string {
  const iconFile =
    process.platform === "win32"
      ? "icon.ico"
      : process.platform === "darwin"
        ? "icon.icns"
        : "icon.png";
  if (app.isPackaged) {
    return join(process.resourcesPath, iconFile);
  }
  return join(app.getAppPath(), "build", iconFile);
}

// ---------------------------------------------------------------------------
// Sleep-resilient server lifecycle (self-healing restart + power save blocker)
// ---------------------------------------------------------------------------

/** Sliding window for counting silent restarts before escalating to the crash dialog. */
const SILENT_RESTART_WINDOW_MS = 60_000;
/** Silent restarts allowed within the window; the next failure shows the crash dialog. */
const SILENT_RESTART_LIMIT = 3;

/** Timestamps of recent silent restarts (pruned to the sliding window). */
let silentRestartTimestamps: number[] = [];
/** Single in-flight ensure promise so concurrent triggers (resume + renderer fallback) coalesce. */
let ensureInFlight: Promise<void> | null = null;

/** Show the Restart / Quit dialog used when the server crashes or restart-loops. */
async function showServerCrashDialog(code: number | null): Promise<void> {
  if (!mainWindow) return;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "error",
    title: "Server crashed",
    message: `The Mcode server exited unexpectedly (code ${code ?? "unknown"}).`,
    buttons: ["Restart", "Quit"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    await serverManager.restart();
  } else {
    app.quit();
  }
}

/** Notify the user after an automatic backend restart succeeds. */
function showServerRecoveredNotification(code: number | null): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: "Mcode server recovered",
    body: `The backend crashed (code ${code ?? "unknown"}) and restarted.`,
  });
  notification.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  notification.show();
}

/**
 * Verify the server is reachable and silently restart it if not.
 * Called on OS resume and from the renderer's reconnect fallback.
 * Escalates to the crash dialog after {@link SILENT_RESTART_LIMIT} silent
 * restarts within {@link SILENT_RESTART_WINDOW_MS} — a restart loop means
 * something is genuinely broken and hiding it would strand the user.
 */
function ensureServerRunning(): Promise<void> {
  if (ensureInFlight) return ensureInFlight;
  ensureInFlight = (async () => {
    if (await serverManager.isHealthy()) return;

    const now = Date.now();
    silentRestartTimestamps = silentRestartTimestamps.filter(
      (t) => now - t < SILENT_RESTART_WINDOW_MS,
    );
    if (silentRestartTimestamps.length >= SILENT_RESTART_LIMIT) {
      await showServerCrashDialog(null);
      return;
    }
    silentRestartTimestamps.push(now);

    console.log("[main] Server unhealthy, restarting silently");
    try {
      await serverManager.restart();
    } catch (err) {
      console.error("[main] Silent server restart failed:", err);
    }
  })().finally(() => {
    ensureInFlight = null;
  });
  return ensureInFlight;
}

/** WebContents ids that currently report the server as busy. */
const busySenders = new Set<number>();
/** Sender ids that already have a destroyed-cleanup listener registered. */
const busyCleanupRegistered = new Set<number>();
/** Active powerSaveBlocker id, or null when not blocking. */
let powerSaveBlockerId: number | null = null;

/** Start/stop the app-suspension blocker to match the busy-sender set. */
function updatePowerSaveBlocker(): void {
  if (busySenders.size > 0) {
    if (powerSaveBlockerId === null) {
      powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
      console.log("[main] Power save blocker started (server busy)");
    }
  } else if (powerSaveBlockerId !== null) {
    powerSaveBlocker.stop(powerSaveBlockerId);
    powerSaveBlockerId = null;
    console.log("[main] Power save blocker stopped (server idle)");
  }
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

/** Create the main BrowserWindow and load the web app. */
function createWindow(): void {
  const terminalReleaseTestEnabled = isTerminalReleaseTestEnabled(
    app.isPackaged,
    process.env.MCODE_TERMINAL_RELEASE_TEST,
  );
  const terminalReleaseTestArguments =
    buildTerminalReleaseTestRendererArguments(terminalReleaseTestEnabled);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: getWindowIconPath(),
    // Keep window hidden until first paint to eliminate the blank white flash.
    show: false,
    backgroundColor: "#0a0a0f",
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 12 },
        }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "#00000000",
            symbolColor: "#8a8a92",
            height: 40,
          },
        }),
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      ...(terminalReleaseTestArguments.length > 0
        ? { additionalArguments: terminalReleaseTestArguments }
        : {}),
      contextIsolation: true,
      nodeIntegration: false,
      // Documented explicitly; defaults to true in Electron but we set it
      // here for clarity. The load-bearing call is setSpellCheckerLanguages().
      spellcheck: true,
      // Phase D of the in-app browser rewrite: enable <webview> so the
      // renderer can host a guest WebContents whose id is later adopted by
      // the Browser automation host. webview-tag carries Chromium guest
      // process risks; the will-attach-webview hook below clamps webPreferences
      // and we never expose nodeIntegrationInSubFrames.
      webviewTag: true,
      // Chromium DevTools only in `bun run dev:desktop` (ELECTRON_RENDERER_URL).
      // Packaged releases and local `bun run prod` keep DevTools disabled.
      devTools: isDesktopDev(),
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.on("close", () => {
    disposePreviewForWindow(mainWindow!);
    disposeBrowserAutomationForWindow(mainWindow!.id);
  });

  // Intercept target="_blank" and window.open() calls.
  // Deny the new window and open the URL in the system browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openIfAllowed(url);
    return { action: "deny" };
  });

  // Harden every <webview> and replace any renderer-supplied preload with the
  // fixed takeover bridge bundled with the desktop application.
  mainWindow.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    hardenPreviewWebviewAttachment(
      webPreferences,
      params,
      resolvePreviewGuestPreloadPath(__dirname),
    );
  });

  // Prevent the main window from navigating away from the app.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentUrl = mainWindow!.webContents.getURL();
    // Allow same-origin navigation for the SPA router (dev mode http://localhost).
    // In production (file://), origin is "null" so all navigation is blocked,
    // which is correct since the SPA uses pushState routing.
    try {
      const current = new URL(currentUrl);
      const target = new URL(url);
      if (current.origin !== "null" && current.origin === target.origin) return;
    } catch {
      // Parse error, fall through to block
    }
    event.preventDefault();
    openIfAllowed(url);
  });

  // Show the window as soon as the first frame is painted.
  // Fallback timeout ensures the window becomes visible even if the
  // ready-to-show event never fires (e.g. renderer crash before first paint).
  const showFallback = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  }, 3000);
  mainWindow.once("ready-to-show", () => {
    clearTimeout(showFallback);
    mainWindow?.show();
  });
  mainWindow.once("closed", () => clearTimeout(showFallback));

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  if (isDesktopDev()) {
    mainWindow.webContents.once("did-finish-load", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.openDevTools({ mode: "right" });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// IPC handler registration
// ---------------------------------------------------------------------------

/** Register all native-only IPC handlers. */
function registerIpcHandlers(): void {
  if (isFrontendPerformanceRun()) {
    ipcMain.handle(FRONTEND_PERFORMANCE_METRICS_CHANNEL, (event) => {
      if (!mainWindow || event.sender !== mainWindow.webContents) {
        throw new Error("Performance metrics require the main renderer");
      }
      return getFrontendPerformanceMetrics();
    });
    ipcMain.handle(FRONTEND_PERFORMANCE_QUIT_CHANNEL, async (event) => {
      if (!mainWindow || event.sender !== mainWindow.webContents) {
        throw new Error("Performance cleanup requires the main renderer");
      }
      await serverManager.forceReplace();
      app.quit();
    });
  }

  // Server URL for WebSocket connection
  ipcMain.handle("get-server-url", () => ({
    url: `ws://localhost:${serverManager.port}?token=${serverManager.authToken}`,
    ipcPath: serverManager.ipcPath,
  }));

  // Native file dialog
  ipcMain.handle(
    "show-open-dialog",
    async (_event, options: Record<string, unknown>) => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"],
        title: (options?.title as string) || "Select a folder",
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    },
  );

  // Open-in app metadata + detection, sourced from the registry. The renderer
  // reads labels, icon keys, and kinds from here rather than a local copy.
  ipcMain.handle("list-open-in-apps", () => {
    return openInRegistry.list();
  });

  // Unified open-in seam: dispatch a path to the registry adapter for `appId`.
  // The registry rejects unknown ids, so no separate allowlist is needed — the
  // same handler opens an editor or reveals a path in the file manager. `line`
  // is honored only by editor adapters with a file target (directories ignore it).
  ipcMain.handle(
    "open-in",
    async (_event, appId: string, targetPath: string, line?: number) => {
      if (!isAbsolute(targetPath)) {
        throw new Error("Open-in path must be absolute");
      }
      if (!existsSync(targetPath)) {
        throw new Error(`Path does not exist: ${targetPath}`);
      }
      await openInRegistry.launch(appId, { path: targetPath, line });
    },
  );

  // Open external URL (https, http, mailto), or workspace-relative preview targets in the default browser.
  ipcMain.handle(
    "open-external-url",
    async (_event, url: string, workspacePath?: string | null) => {
      const trimmed = typeof url === "string" ? url.trim() : "";
      if (!trimmed) return;
      if (isMcodeWorkspacePreviewUrl(trimmed)) {
        const ws =
          typeof workspacePath === "string" && workspacePath.trim().length > 0
            ? workspacePath.trim()
            : null;
        const resolved = await resolveMcodeWorkspacePreviewUrl(trimmed, ws);
        if (!resolved.ok) return;
        void shell.openExternal(resolved.url).catch((err: unknown) => {
          console.error(
            `[open-external-url] Failed to open file URL: ${resolved.url}`,
            err,
          );
        });
        return;
      }
      openIfAllowed(trimmed);
    },
  );

  // Read clipboard image and save to temp JPEG
  ipcMain.handle("read-clipboard-image", async () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;

    const buffer = img.toJPEG(85);
    const id = randomUUID();
    const name = `clipboard-${Date.now()}.jpg`;
    const tempDir = join(app.getPath("temp"), "mcode-attachments");
    await mkdir(tempDir, { recursive: true });
    const tempPath = join(tempDir, `${id}.jpg`);
    await writeFile(tempPath, buffer);

    return {
      id,
      name,
      mimeType: "image/jpeg",
      sizeBytes: buffer.byteLength,
      sourcePath: tempPath,
    };
  });

  // Save a clipboard file blob to a temp location and return metadata
  ipcMain.handle(
    "save-clipboard-file",
    async (_event, buffer: Uint8Array, mimeType: string, fileName: string) => {
      const id = randomUUID();
      const ext = getExtension(fileName);
      const suffix = ext ? `.${ext}` : "";
      const tempDir = join(app.getPath("temp"), "mcode-attachments");
      await mkdir(tempDir, { recursive: true });
      const tempPath = join(tempDir, `${id}${suffix}`);
      await writeFile(tempPath, Buffer.from(buffer));
      return {
        id,
        name: fileName,
        mimeType,
        sizeBytes: buffer.byteLength,
        sourcePath: tempPath,
      };
    },
  );

  // Log path
  ipcMain.handle("get-log-path", () => {
    return getLogPath();
  });

  // Recent log lines
  ipcMain.handle("get-recent-logs", (_event, lines: number) => {
    return getRecentLogs(lines);
  });

  // Renderer crash diagnostics are local-only and accepted only from the main app window.
  ipcMain.handle(RENDERER_CRASH_REPORT_CHANNEL, (event, payload: unknown) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    handleRendererCrashReport(event, payload, mainWindow.webContents);
  });

  /** Ensure a config file exists in the mcode data dir, then open it. */
  async function ensureAndOpenConfigFile(
    fileName: string,
    defaultContent: string,
  ): Promise<string> {
    const dir = getMcodeDir();
    const filePath = join(dir, fileName);
    if (!existsSync(filePath)) {
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, defaultContent, "utf8");
    }
    const err = await shell.openPath(filePath);
    if (err) {
      throw new Error(`Failed to open ${fileName}: ${err}`);
    }
    return "";
  }

  ipcMain.handle("open-settings-file", () =>
    ensureAndOpenConfigFile("settings.json", "{}\n"),
  );

  ipcMain.handle("open-keybindings-file", () =>
    ensureAndOpenConfigFile("keybindings.json", "[]\n"),
  );

  // Spellcheck: replace misspelled word under cursor.
  // Registered here (not in setupSpellcheck) so it is only registered once,
  // avoiding "second handler" crashes on macOS window re-creation.
  ipcMain.handle("spellcheck:replace-misspelling", (_event, word: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.replaceMisspelling(word);
    }
  });

  // Spellcheck: add word to Chromium's custom dictionary (persists across sessions).
  ipcMain.handle("spellcheck:add-to-dictionary", (_event, word: string) => {
    session.defaultSession.addWordToSpellCheckerDictionary(word);
  });

  // Spellcheck: paste via Electron's native webContents.paste() (execCommand is unreliable).
  ipcMain.handle("spellcheck:paste", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.paste();
    }
  });

  // Renderer fallback: verify the server is up, silently restart if not.
  ipcMain.handle("ensure-server-running", () => ensureServerRunning());

  // Busy reporting: while any sender is busy, hold a power save blocker so
  // the OS does not suspend the machine mid-turn. Refcounted per webContents
  // and cleared on destroy so a crashed/closed renderer cannot leak the blocker.
  ipcMain.handle("set-server-busy", (event, busy: boolean) => {
    const id = event.sender.id;
    if (busy) {
      busySenders.add(id);
      if (!busyCleanupRegistered.has(id)) {
        busyCleanupRegistered.add(id);
        event.sender.once("destroyed", () => {
          busySenders.delete(id);
          busyCleanupRegistered.delete(id);
          updatePowerSaveBlocker();
        });
      }
    } else {
      busySenders.delete(id);
    }
    updatePowerSaveBlocker();
  });

  ipcMain.handle("accessibility:get-support", (event): boolean => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error("Accessibility support requires the main renderer");
    }
    const supported = app.isAccessibilitySupportEnabled();
    if (typeof supported !== "boolean") {
      throw new Error("Electron returned an invalid accessibility support value");
    }
    return supported;
  });

  ipcMain.handle("window:perform", (event, action: unknown) => {
    if (
      typeof action !== "string" ||
      !DESKTOP_WINDOW_ACTIONS.has(action as DesktopWindowAction)
    ) {
      throw new Error("Invalid desktop window action");
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    performDesktopWindowAction(window, action as DesktopWindowAction);
  });

  // App version + auto-update controls
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("app:get-update-status", () => getUpdateStatus());
  ipcMain.handle("app:check-for-updates", () => checkForUpdatesNow());
  ipcMain.handle("app:install-update", () => installUpdate());
  ipcMain.handle("app:download-update", () => downloadUpdate());
  ipcMain.handle(
    "app:apply-release-line",
    async (
      _e,
      payload: { releaseLine: "stable" | "nightly"; allowDowngrade?: boolean },
    ) => {
      if (
        payload?.releaseLine !== "stable" &&
        payload?.releaseLine !== "nightly"
      ) {
        throw new Error(`Invalid releaseLine: ${String(payload?.releaseLine)}`);
      }
      return applyReleaseLineSwitch(payload.releaseLine, {
        allowDowngrade: payload.allowDowngrade === true,
      });
    },
  );

  registerPreviewBrowserHandlers();
}

// ---------------------------------------------------------------------------
// Attachment protocol handler
// ---------------------------------------------------------------------------

/** Register the mcode-attachment:// protocol for serving attachment files. */
function registerAttachmentProtocol(): void {
  protocol.handle("mcode-attachment", async (request) => {
    const url = new URL(request.url);
    const threadId = url.hostname;
    const filename = url.pathname.replace(/^\//, "");

    if (!VALID_ATTACHMENT_ID.test(threadId)) {
      return new Response("Invalid thread ID", { status: 400 });
    }
    if (!/^[a-f0-9-]+\.\w+$/.test(filename)) {
      return new Response("Invalid attachment ID", { status: 400 });
    }

    const filePath = join(getMcodeDir(), "attachments", threadId, filename);
    if (!existsSync(filePath)) {
      return new Response("Not found", { status: 404 });
    }

    const ext = filename.split(".").pop() ?? "";
    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    return new Response(webStream, {
      headers: {
        "Content-Type": MIME_MAP[ext] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Close handler
// ---------------------------------------------------------------------------

/** Confirm close when agents are running, then shut down the server. */
function setupCloseHandler(): void {
  if (!mainWindow) return;

  mainWindow.on("close", async (event) => {
    // Check active agent count via the server's HTTP API
    let count = 0;
    try {
      const res = await fetch(`http://localhost:${serverManager.port}/health`);
      if (res.ok) {
        const data = (await res.json()) as { activeAgents?: number };
        count = data.activeAgents ?? 0;
      }
    } catch {
      // Server unreachable, allow close
    }

    if (count > 0) {
      event.preventDefault();
      const plural = count === 1 ? " is" : "s are";
      const message =
        `${count} agent${plural} still working. ` +
        "They'll resume when you reopen Mcode.";

      const { response } = await dialog.showMessageBox(mainWindow!, {
        type: "question",
        title: "Agents Running",
        message,
        buttons: ["Continue", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      });

      if (response === 0) {
        app.quit();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Keep disabled acceleration as the product default and rollback path. The
// packaged performance runner can request Electron's default for paired tests.
// This call must occur before app.whenReady().
if (HARDWARE_ACCELERATION_MODE === "disabled") app.disableHardwareAcceleration();

// Pre-cache compiled V8 bytecode to disk so subsequent launches skip
// re-parsing the renderer bundle (mirrors VS Code's approach).
app.commandLine.appendSwitch("v8-cache-options", "code");

// Instruct Blink to aggressively evict memory caches under idle conditions.
app.commandLine.appendSwitch("aggressive-cache-discard");

// The renderer communicates via a local WebSocket - there is no HTTP content
// worth persisting to disk. Remove the disk cache overhead.
app.commandLine.appendSwitch("disable-disk-cache");

// Cap renderer V8 heap. Browser surfaces load arbitrary third-party
// pages that can exceed 128 MB, so the limit is raised to 2 GB. The main
// renderer still benefits from young-generation capping (2 MB semi-space).
app.commandLine.appendSwitch(
  "js-flags",
  "--max-old-space-size=2048 --max-semi-space-size=2",
);

if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

/** Native window and edit commands accepted from the context-isolated renderer. */
export type DesktopWindowAction =
  | "closeWindow"
  | "quit"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "toggleFullScreen"
  | "reload"
  | "toggleDevTools";

/** Explicit allowlist for native actions exposed through IPC. */
export const DESKTOP_WINDOW_ACTIONS = new Set<DesktopWindowAction>([
  "closeWindow",
  "quit",
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "toggleFullScreen",
  "reload",
  "toggleDevTools",
]);

function performDesktopWindowAction(
  window: BrowserWindow,
  action: DesktopWindowAction,
): void {
  switch (action) {
    case "closeWindow":
      window.close();
      return;
    case "quit":
      app.quit();
      return;
    case "undo":
      window.webContents.undo();
      return;
    case "redo":
      window.webContents.redo();
      return;
    case "cut":
      window.webContents.cut();
      return;
    case "copy":
      window.webContents.copy();
      return;
    case "paste":
      window.webContents.paste();
      return;
    case "selectAll":
      window.webContents.selectAll();
      return;
    case "zoomIn":
      window.webContents.setZoomLevel(window.webContents.getZoomLevel() + 0.5);
      return;
    case "zoomOut":
      window.webContents.setZoomLevel(window.webContents.getZoomLevel() - 0.5);
      return;
    case "zoomReset":
      window.webContents.setZoomLevel(0);
      return;
    case "toggleFullScreen":
      window.setFullScreen(!window.isFullScreen());
      return;
    case "reload":
      if (isDesktopDev()) window.webContents.reloadIgnoringCache();
      return;
    case "toggleDevTools":
      if (!isDesktopDev()) return;
      if (window.webContents.isDevToolsOpened())
        window.webContents.closeDevTools();
      else window.webContents.openDevTools({ mode: "right" });
  }
}

type DesktopRendererCommand =
  | "workspace.new"
  | "thread.new"
  | "sidebar.toggle"
  | "rightPanel.toggle"
  | "settings.keyboard"
  | "settings.about";

function sendDesktopRendererCommand(command: DesktopRendererCommand): void {
  const target = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!target || target.isDestroyed()) return;
  target.webContents.send("desktop:command", command);
}

function configureApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      {
        label: "File",
        submenu: [
          {
            label: "New Project",
            accelerator: "CmdOrCtrl+Shift+N",
            click: () => sendDesktopRendererCommand("workspace.new"),
          },
          {
            label: "New Thread",
            accelerator: "CmdOrCtrl+N",
            click: () => sendDesktopRendererCommand("thread.new"),
          },
          { type: "separator" },
          { role: "close" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          {
            label: "Toggle Sidebar",
            accelerator: "CmdOrCtrl+\\",
            click: () => sendDesktopRendererCommand("sidebar.toggle"),
          },
          {
            label: "Toggle Right Panel",
            accelerator: "CmdOrCtrl+Alt+B",
            click: () => sendDesktopRendererCommand("rightPanel.toggle"),
          },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          {
            label: "Keyboard Shortcuts",
            click: () => sendDesktopRendererCommand("settings.keyboard"),
          },
          {
            label: "About Mcode",
            click: () => sendDesktopRendererCommand("settings.about"),
          },
        ],
      },
    ]),
  );
}

// Tag the dev main process so `ps`/console output distinguishes it from a
// packaged instance. process.title does not change app.getName() or the
// userData path, so dev and prod still share data-dir resolution. On packaged
// Windows the Task Manager name comes from the exe VERSIONINFO, not this.
process.title = isDesktopDev() ? "Mcode Desktop (dev)" : "Mcode Desktop";

app.whenReady().then(async () => {
  try {
    console.log(
      `[perf] App ready: ${(performance.now() - STARTUP_TIME).toFixed(1)}ms`,
    );
    console.log(
      `[perf] V8 snapshot: ${globalThis.__v8Snapshot ? "loaded" : "not available"}`,
    );
    console.log(`Mcode v${app.getVersion()} starting`);
    if (shouldSetDockIcon(process.platform, app.isPackaged)) {
      app.dock?.setIcon(getWindowIconPath());
    }
    configureApplicationMenu();

    // Start the server child process
    const { port } = await serverManager.start();
    console.log(
      `[perf] Server ready: ${(performance.now() - STARTUP_TIME).toFixed(1)}ms`,
    );
    console.log(`Server started on port ${port}`);

    // Stop the detached server before any quitAndInstall so the NSIS
    // installer does not hit locked files under the install directory.
    setBeforeInstallHook(
      createBeforeInstallHook(() => serverManager.forceReplace()),
    );

    // Recover once the server process exits unexpectedly.
    serverManager.onUnexpectedExit = (code) => {
      void serverCrashRecovery.handleUnexpectedExit(code);
    };

    // Self-heal after sleep: the server's grace timer or the OS may have
    // killed it while the machine was suspended.
    powerMonitor.on("resume", () => {
      void ensureServerRunning();
    });

    // Register custom protocol for attachment files
    registerAttachmentProtocol();

    // Register IPC handlers BEFORE creating the window so the renderer can
    // invoke get-server-url as soon as it loads, without racing the handler.
    registerIpcHandlers();

    // Set auth cookie so the renderer can authenticate to the server via HTTP
    await session.defaultSession.cookies.set({
      url: `http://localhost:${serverManager.port}`,
      name: "mcode-auth",
      value: serverManager.authToken,
      httpOnly: true,
      sameSite: "strict",
    });

    // Create window
    createWindow();
    console.log(
      `[perf] Window created: ${(performance.now() - STARTUP_TIME).toFixed(1)}ms`,
    );

    // Enable spellchecker and attach per-window context-menu handler.
    setupSpellcheck(mainWindow!);

    // Start IPC push relay (main process → renderer via webContents.send).
    // Destroy the socket when the window closes to prevent named-pipe handle leaks.
    if (mainWindow && serverManager.ipcPath) {
      const cleanupRelay = startIpcRelay(serverManager.ipcPath, mainWindow);
      mainWindow.once("closed", cleanupRelay);
    }

    // Set up close handler
    setupCloseHandler();

    // macOS: re-create window when dock icon is clicked
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        setupSpellcheck(mainWindow!);
        setupCloseHandler();
        if (mainWindow && serverManager.ipcPath) {
          const cleanupRelay = startIpcRelay(serverManager.ipcPath, mainWindow);
          mainWindow.once("closed", cleanupRelay);
        }
      }
    });

    // Initialize auto-updater (checks still run in dev; install hooks are packaged-only paths)
    initAutoUpdater();

    console.log(
      `[perf] Startup complete: ${(performance.now() - STARTUP_TIME).toFixed(1)}ms`,
    );
  } catch (error) {
    const detail =
      error instanceof Error
        ? `${error.message}\n\n${error.stack ?? ""}`
        : String(error);
    console.error("Failed to start desktop app", error);
    dialog.showErrorBox("Mcode failed to start", detail);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  cleanupAutoUpdater();
});

export { mainWindow };
