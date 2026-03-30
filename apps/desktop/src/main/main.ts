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
import { getExtension } from "@mcode/contracts";
import { ServerManager } from "./server-manager.js";

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
function openInEditor(editor: EditorId, dirPath: string): void {
  const cmd = resolvedEditors?.get(editor);
  if (!cmd) {
    throw new Error(`Editor not detected: ${editor}. Call detectEditors() first.`);
  }

  let child: ChildProcess;
  if (process.platform === "win32" && cmd.endsWith(".cmd")) {
    child = spawn("cmd.exe", ["/c", cmd, dirPath], {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
    });
  } else {
    child = spawn(cmd, [dirPath], { detached: true, stdio: "ignore" });
  }
  child.unref();
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
    backgroundColor: "#0a0a0f",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

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
    (_event, editor: string, dirPath: string) => {
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
      openInEditor(editor as EditorId, dirPath);
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

  // Open external URL (https only)
  ipcMain.handle("open-external-url", (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:") {
        shell.openExternal(url);
      }
    } catch {
      // Invalid URL, ignore
    }
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

// Cap renderer V8 heap at 128MB to prevent over-allocation during
// markdown rendering and syntax highlighting.
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=128");

app.whenReady().then(async () => {
  console.log(`Mcode v${app.getVersion()} starting`);

  // Start the server child process
  const { port } = await serverManager.start();
  console.log(`Server started on port ${port}`);

  // Register custom protocol for attachment files
  registerAttachmentProtocol();

  // Create window
  createWindow();

  // Register native-only IPC handlers
  registerIpcHandlers();

  // Set up close handler
  setupCloseHandler();

  // macOS: re-create window when dock icon is clicked
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      setupCloseHandler();
    }
  });
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
