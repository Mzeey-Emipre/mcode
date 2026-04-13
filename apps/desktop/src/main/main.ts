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
  protocol,
  shell,
} from "electron";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { existsSync, createReadStream } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { isAbsolute, join } from "path";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { getLogPath, getMcodeDir, getRecentLogs } from "@mcode/shared";
import { getExtension as bundledGetExtension } from "@mcode/contracts";

/** Use snapshot-provided module when available (V8 snapshot skips re-init). */
const getExtension = globalThis.__v8Snapshot?.contracts?.getExtension ?? bundledGetExtension;
import { ServerManager } from "./server-manager.js";
import { initAutoUpdater } from "./auto-updater.js";

// ---------------------------------------------------------------------------
// Editor detection (inlined from editors.ts)
// ---------------------------------------------------------------------------

/** Supported editor identifiers. */
type EditorId = "code" | "cursor" | "zed";

interface EditorMeta {
  readonly id: EditorId;
  readonly label: string;
  readonly windowsPaths?: readonly string[];
}

const KNOWN_EDITORS: readonly EditorMeta[] = [
  {
    id: "code",
    label: "VS Code",
    windowsPaths: [
      join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Microsoft VS Code",
        "bin",
        "code.cmd",
      ),
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    windowsPaths: [
      join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "cursor",
        "resources",
        "app",
        "bin",
        "cursor.cmd",
      ),
      join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Cursor",
        "resources",
        "app",
        "bin",
        "cursor.cmd",
      ),
    ],
  },
  {
    id: "zed",
    label: "Zed",
    windowsPaths: [
      join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Zed",
        "bin",
        "zed.exe",
      ),
      join(
        process.env.LOCALAPPDATA ?? "",
        "Zed",
        "bin",
        "zed.exe",
      ),
    ],
  },
];

/** Cached map from editor ID to resolved executable path. */
let resolvedEditors: Map<EditorId, string> | null = null;

/** Check whether a CLI command exists on the system PATH. */
function commandOnPath(cmd: string): boolean {
  const checkCmd = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(checkCmd, [cmd], { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

/** Find the executable path for an editor, checking PATH then known install locations. */
function findEditorCommand(editor: EditorMeta): string | null {
  if (commandOnPath(editor.id)) return editor.id;
  if (process.platform === "win32" && editor.windowsPaths) {
    for (const p of editor.windowsPaths) {
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Detect which supported editors are installed. Returns list of editor IDs. */
function detectEditors(): EditorId[] {
  if (resolvedEditors !== null) return [...resolvedEditors.keys()];

  resolvedEditors = new Map();
  for (const editor of KNOWN_EDITORS) {
    const cmd = findEditorCommand(editor);
    if (cmd) resolvedEditors.set(editor.id, cmd);
  }
  return [...resolvedEditors.keys()];
}

/** Open a directory in the given editor as a detached process. */
function openInEditor(editor: EditorId, dirPath: string): Promise<void> {
  const cmd = resolvedEditors?.get(editor);
  if (!cmd) {
    return Promise.reject(
      new Error(`Editor not detected: ${editor}. Call detectEditors() first.`),
    );
  }

  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    // On Windows, always route through cmd.exe because PATH-resolved commands
    // (e.g. "code") are .cmd scripts that Node's spawn cannot execute directly.
    if (process.platform === "win32") {
      child = spawn("cmd.exe", ["/c", cmd, dirPath], {
        detached: true,
        stdio: "ignore",
      });
    } else {
      child = spawn(cmd, [dirPath], { detached: true, stdio: "ignore" });
    }

    child.on("error", (err: Error) => {
      reject(new Error(err.message));
    });

    // If the process spawned successfully, resolve on next tick.
    // The "spawn" event fires once the child process has been created.
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
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
        console.error(`[openIfAllowed] Failed to open ${parsed.protocol} URL: ${parsed.href}`, err);
      });
    }
  } catch {
    // Invalid URL, ignore
  }
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
const serverManager = new ServerManager();

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

/** Create the main BrowserWindow and load the web app. */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // Keep window hidden until first paint to eliminate the blank white flash.
    show: false,
    backgroundColor: "#0a0a0f",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.setMenuBarVisibility(false);

  // Intercept target="_blank" and window.open() calls.
  // Deny the new window and open the URL in the system browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openIfAllowed(url);
    return { action: "deny" };
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
}

// ---------------------------------------------------------------------------
// IPC handler registration
// ---------------------------------------------------------------------------

/** Register all native-only IPC handlers. */
function registerIpcHandlers(): void {
  // Server URL for WebSocket connection
  ipcMain.handle("get-server-url", () => {
    return `ws://localhost:${serverManager.port}?token=${serverManager.authToken}`;
  });

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

  // Editor detection
  ipcMain.handle("detect-editors", () => {
    return detectEditors();
  });

  // Open in editor
  ipcMain.handle(
    "open-in-editor",
    async (_event, editor: string, dirPath: string) => {
      if (!isAbsolute(dirPath)) {
        throw new Error("Editor path must be absolute");
      }
      if (!existsSync(dirPath)) {
        throw new Error(`Path does not exist: ${dirPath}`);
      }
      const validEditors = new Set(["code", "cursor", "zed"]);
      if (!validEditors.has(editor)) {
        throw new Error(`Unknown editor: ${editor}`);
      }
      await openInEditor(editor as EditorId, dirPath);
    },
  );

  // Open in file explorer
  ipcMain.handle("open-in-explorer", (_event, dirPath: string) => {
    if (!isAbsolute(dirPath)) {
      throw new Error("Explorer path must be absolute");
    }
    if (!existsSync(dirPath)) {
      throw new Error(`Path does not exist: ${dirPath}`);
    }
    return shell.openPath(dirPath);
  });

  // Open external URL (https, http, mailto)
  ipcMain.handle("open-external-url", (_event, url: string) => {
    openIfAllowed(url);
  });

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

    const filePath = join(
      getMcodeDir(),
      "attachments",
      threadId,
      filename,
    );
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
      const res = await fetch(
        `http://localhost:${serverManager.port}/health`,
      );
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
        serverManager.shutdown();
        app.quit();
      }
    } else {
      serverManager.shutdown();
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Disable GPU process - the app renders text and markdown only, no WebGL or
// hardware-accelerated graphics. Eliminates the ~70 MB GPU process.
// Must be called before app.whenReady().
app.disableHardwareAcceleration();

// Pre-cache compiled V8 bytecode to disk so subsequent launches skip
// re-parsing the renderer bundle (mirrors VS Code's approach).
app.commandLine.appendSwitch("v8-cache-options", "code");

// Instruct Blink to aggressively evict memory caches under idle conditions.
app.commandLine.appendSwitch("aggressive-cache-discard");

// The renderer communicates via a local WebSocket - there is no HTTP content
// worth persisting to disk. Remove the disk cache overhead.
app.commandLine.appendSwitch("disable-disk-cache");

// Cap renderer V8 heap at 128 MB and young-generation semi-space at 2 MB
// to prevent over-allocation during markdown rendering and syntax highlighting.
app.commandLine.appendSwitch(
  "js-flags",
  "--max-old-space-size=128 --max-semi-space-size=2",
);

app.whenReady().then(async () => {
  try {
    console.log(`[perf] App ready: ${(performance.now() - STARTUP_TIME).toFixed(1)}ms`);
    console.log(`[perf] V8 snapshot: ${globalThis.__v8Snapshot ? "loaded" : "not available"}`);
    console.log(`Mcode v${app.getVersion()} starting`);

    // Start the server child process
    const { port } = await serverManager.start();
    console.log(`[perf] Server ready: ${(performance.now() - STARTUP_TIME).toFixed(1)}ms`);
    console.log(`Server started on port ${port}`);

    // Show a Restart / Quit dialog if the server crashes unexpectedly
    serverManager.onUnexpectedExit = async (code) => {
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
    };

    // Register custom protocol for attachment files
    registerAttachmentProtocol();

    // Register IPC handlers BEFORE creating the window so the renderer can
    // invoke get-server-url as soon as it loads, without racing the handler.
    registerIpcHandlers();


    // Create window
    createWindow();
    console.log(`[perf] Window created: ${(performance.now() - STARTUP_TIME).toFixed(1)}ms`);

    // Set up close handler
    setupCloseHandler();

    // macOS: re-create window when dock icon is clicked
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        setupCloseHandler();
      }
    });

    // Initialize auto-updater (no-op in dev — guarded by app.isPackaged)
    initAutoUpdater();

    console.log(`[perf] Startup complete: ${(performance.now() - STARTUP_TIME).toFixed(1)}ms`);
  } catch (error) {
    const detail = error instanceof Error ? `${error.message}\n\n${error.stack ?? ""}` : String(error);
    console.error("Failed to start desktop app", error);
    dialog.showErrorBox("Mcode failed to start", detail);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    serverManager.shutdown();
    app.quit();
  }
});

app.on("before-quit", () => {
  serverManager.shutdown();
});

export { mainWindow };
