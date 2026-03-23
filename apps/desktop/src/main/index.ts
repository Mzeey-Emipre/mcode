/**
 * Electron main process entry point.
 * Ported from apps/desktop/src/lib.rs
 *
 * Responsibilities:
 *   - Create BrowserWindow
 *   - Initialize AppState (database, sidecar)
 *   - Register IPC handlers for renderer communication
 *   - Forward sidecar events to the renderer
 *   - Handle graceful shutdown
 */

import { app, BrowserWindow, ipcMain, dialog, protocol, shell } from "electron";
import { isAbsolute, join } from "path";
import { existsSync, mkdirSync, statSync } from "fs";
import { AppState } from "./app-state.js";
import { MCODE_DIR } from "./paths.js";
import { sessionIdFromEvent } from "./sidecar/types.js";
import type { SidecarEvent } from "./sidecar/types.js";
import * as MessageRepo from "./repositories/message-repo.js";
import * as ThreadRepo from "./repositories/thread-repo.js";
import { logger, getLogPath, getRecentLogs } from "./logger.js";
import type { AttachmentMeta } from "./models.js";
import { detectEditors, openInEditor, openInExplorer } from "./editors.js";
import { getBranchPr } from "./github.js";

/** Validated permission mode values accepted by the IPC boundary. */
type SafePermissionMode = "full" | "supervised" | "default";
const VALID_PERMISSION_MODES = new Set<SafePermissionMode>(["full", "supervised", "default"]);

/**
 * Validate a permission mode string from the renderer process.
 * Returns "default" for any unrecognized value, preventing injection
 * of arbitrary strings into the SDK's bypassPermissions flag.
 */
function sanitizePermissionMode(mode?: string): SafePermissionMode {
  return VALID_PERMISSION_MODES.has(mode as SafePermissionMode) ? (mode as SafePermissionMode) : "default";
}

const VALID_ATTACHMENT_ID = /^[a-f0-9-]+$/;
const VALID_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf", "text/plain",
]);
const MAX_ATTACHMENTS = 5;

function validateAttachments(raw?: unknown[]): AttachmentMeta[] {
  if (!raw || !Array.isArray(raw) || raw.length === 0) return [];
  if (raw.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments (max ${MAX_ATTACHMENTS})`);
  }

  return raw.map((item) => {
    const att = item as Record<string, unknown>;
    const id = String(att.id ?? "");
    const name = String(att.name ?? "");
    const mimeType = String(att.mimeType ?? "");
    const sizeBytes = Number(att.sizeBytes ?? 0);
    const sourcePath = String(att.sourcePath ?? "");

    if (!VALID_ATTACHMENT_ID.test(id)) {
      throw new Error(`Invalid attachment ID: ${id}`);
    }
    if (!VALID_MIME_TYPES.has(mimeType)) {
      throw new Error(`Unsupported MIME type: ${mimeType}`);
    }
    if (!sourcePath || !isAbsolute(sourcePath)) {
      throw new Error(`Invalid attachment path: ${sourcePath}`);
    }

    return { id, name, mimeType, sizeBytes, sourcePath };
  });
}

let mainWindow: BrowserWindow | null = null;
let appState: AppState | null = null;

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#0a0a0f",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Remove the menu bar entirely
  mainWindow.setMenuBarVisibility(false);

  // In dev, electron-vite sets ELECTRON_RENDERER_URL to the Vite dev server.
  // In production, load the built renderer from disk.
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// ---------------------------------------------------------------------------
// Event forwarding
// ---------------------------------------------------------------------------

/**
 * Set up event forwarding from the sidecar to the renderer.
 * Mirrors the Tauri setup closure in lib.rs (lines 306-378).
 */
function setupEventForwarding(state: AppState): void {
  const client = state.startSidecar();

  client.on("event", (event: SidecarEvent) => {
    const sessionId = sessionIdFromEvent(event);
    if (sessionId == null) return;

    // Extract thread_id by stripping the "mcode-" prefix
    const threadId = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;

    // Persist assistant messages to DB so they survive navigation
    if (event.method === "session.message") {
      try {
        const existingMsgs = MessageRepo.listByThread(state.db, threadId, 1);
        const nextSeq = existingMsgs.length > 0
          ? existingMsgs[existingMsgs.length - 1].sequence + 1
          : 1;
        MessageRepo.create(
          state.db,
          threadId,
          "assistant",
          event.params.content,
          nextSeq,
        );
      } catch (err) {
        logger.error("Failed to persist assistant message", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Track session lifecycle and persist thread status to DB.
    //
    // Status transitions on session events:
    //   session.message       -> trackSessionStarted (mark as running)
    //   session.turnComplete  -> "completed" (natural finish)
    //   session.ended         -> "completed" (natural finish)
    //   session.error         -> "errored"  (agent failure)
    //
    // Guard: only write "completed" when the DB status is still "active".
    // If the user clicked stop, stopAgent() already wrote "paused" and
    // we must not overwrite it.
    if (event.method === "session.message") {
      state.trackSessionStarted(threadId);
    }
    if (
      event.method === "session.turnComplete" ||
      event.method === "session.ended"
    ) {
      state.trackSessionEnded(threadId);
      try {
        const thread = ThreadRepo.findById(state.db, threadId);
        if (thread && thread.status === "active") {
          ThreadRepo.updateStatus(state.db, threadId, "completed");
        }
      } catch (err) {
        logger.error("Failed to update thread status to completed", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (event.method === "session.error") {
      state.trackSessionEnded(threadId);
      try {
        ThreadRepo.updateStatus(state.db, threadId, "errored");
      } catch (err) {
        logger.error("Failed to update thread status to errored", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Forward to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("agent-event", {
        thread_id: threadId,
        event,
      });
    }
  });

  client.on("error", (err: Error) => {
    logger.error("SidecarClient error", { error: err.message });
  });
}

// ---------------------------------------------------------------------------
// IPC handler registration
// ---------------------------------------------------------------------------

function registerIpcHandlers(state: AppState): void {
  // -- Version --
  ipcMain.handle("get-version", () => {
    return app.getVersion();
  });

  // -- Workspaces --
  ipcMain.handle("list-workspaces", () => {
    return state.listWorkspaces();
  });

  ipcMain.handle("create-workspace", (_event, name: string, path: string) => {
    // Validate workspace path
    if (!isAbsolute(path)) {
      throw new Error("Workspace path must be absolute");
    }
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error("Workspace path must be an existing directory");
    }
    return state.createWorkspace(name, path);
  });

  ipcMain.handle("delete-workspace", (_event, id: string) => {
    return state.deleteWorkspace(id);
  });

  // -- Branches --
  ipcMain.handle("list-branches", (_event, workspaceId: string) => {
    return state.listBranches(workspaceId);
  });

  ipcMain.handle("get-current-branch", (_event, workspaceId: string) => {
    return state.getCurrentBranch(workspaceId);
  });

  ipcMain.handle("checkout-branch", (_event, workspaceId: string, branch: string) => {
    return state.checkoutBranch(workspaceId, branch);
  });

  ipcMain.handle("list-worktrees", (_event, workspaceId: string) => {
    return state.listWorktrees(workspaceId);
  });

  // -- Threads --
  ipcMain.handle("list-threads", (_event, workspaceId: string) => {
    return state.listThreads(workspaceId);
  });

  ipcMain.handle(
    "create-thread",
    (_event, workspaceId: string, title: string, mode: string, branch: string) => {
      return state.createThread(workspaceId, title, mode, branch);
    },
  );

  ipcMain.handle(
    "delete-thread",
    (_event, threadId: string, cleanupWorktree: boolean) => {
      return state.deleteThread(threadId, cleanupWorktree);
    },
  );

  // -- Agent --
  ipcMain.handle(
    "send-message",
    async (_event, threadId: string, content: string, model?: string, permissionMode?: string, attachments?: unknown[]) => {
      const validatedAttachments = validateAttachments(attachments);
      await state.sendMessage(threadId, content, sanitizePermissionMode(permissionMode), model, validatedAttachments);
    },
  );

  // -- Lazy thread creation --
  ipcMain.handle(
    "create-and-send-message",
    async (
      _event,
      workspaceId: string,
      content: string,
      model: string,
      permissionMode?: string,
      mode?: string,
      branch?: string,
      existingWorktreePath?: string,
      attachments?: unknown[],
    ) => {
      const validatedAttachments = validateAttachments(attachments);
      return state.createAndSendMessage(
        workspaceId, content, model,
        sanitizePermissionMode(permissionMode),
        (mode as "direct" | "worktree") ?? "direct",
        branch ?? "main",
        existingWorktreePath ?? undefined,
        validatedAttachments,
      );
    },
  );

  // -- Thread rename --
  ipcMain.handle(
    "update-thread-title",
    (_event, threadId: string, title: string) => {
      return state.updateThreadTitle(threadId, title);
    },
  );

  /**
   * Clear the "completed" badge when the user opens a thread.
   * Transitions completed -> paused so the sidebar no longer shows the
   * green indicator. No-op for threads in any other status.
   */
  ipcMain.handle("mark-thread-viewed", (_event, threadId: string) => {
    const thread = ThreadRepo.findById(state.db, threadId);
    if (thread && thread.status === "completed") {
      ThreadRepo.updateStatus(state.db, threadId, "paused");
    }
  });

  ipcMain.handle("stop-agent", (_event, threadId: string) => {
    state.stopAgent(threadId);
  });

  ipcMain.handle("get-active-agent-count", () => {
    return state.activeAgentCount();
  });

  // -- Messages --
  ipcMain.handle("get-messages", (_event, threadId: string, limit: number) => {
    return state.getMessages(threadId, limit);
  });

  // -- Config --
  ipcMain.handle("discover-config", (_event, workspacePath: string) => {
    return state.getConfig(workspacePath);
  });

  // -- Dialog --
  ipcMain.handle("show-open-dialog", async (_event, options: Record<string, unknown>) => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: (options?.title as string) || "Select a folder",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // -- Logs --
  ipcMain.handle("get-log-path", () => {
    return getLogPath();
  });

  ipcMain.handle("get-recent-logs", (_event, lines: number) => {
    return getRecentLogs(lines);
  });

  ipcMain.handle("read-clipboard-image", async () => {
    return state.readClipboardImage();
  });

  // -- Editor actions --
  ipcMain.handle("detect-editors", () => {
    return detectEditors();
  });

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
      openInEditor(editor as "code" | "cursor" | "zed", dirPath);
    },
  );

  ipcMain.handle("open-in-explorer", (_event, dirPath: string) => {
    if (!isAbsolute(dirPath)) {
      throw new Error("Explorer path must be absolute");
    }
    if (!existsSync(dirPath)) {
      throw new Error(`Path does not exist: ${dirPath}`);
    }
    return openInExplorer(dirPath);
  });

  // -- GitHub PR --
  ipcMain.handle(
    "get-branch-pr",
    async (_event, branch: string, cwd: string) => {
      if (!branch || !cwd) return null;
      if (!isAbsolute(cwd)) {
        throw new Error("Working directory must be absolute");
      }
      if (!existsSync(cwd)) return null;
      return getBranchPr(branch, cwd);
    },
  );

  // -- External URLs (safe shell.openExternal for renderer) --
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
}

// ---------------------------------------------------------------------------
// Window close handler
// ---------------------------------------------------------------------------

function setupCloseHandler(state: AppState): void {
  if (!mainWindow) return;

  mainWindow.on("close", (event) => {
    const count = state.activeAgentCount();

    if (count > 0) {
      // Prevent immediate close and show confirmation dialog
      event.preventDefault();

      const plural = count === 1 ? " is" : "s are";
      const message =
        `${count} agent${plural} still working. ` +
        "They'll resume when you reopen Mcode.";

      dialog
        .showMessageBox(mainWindow!, {
          type: "question",
          title: "Agents Running",
          message,
          buttons: ["Continue", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          if (response === 0) {
            state.shutdown();
            app.quit();
          }
        });
    } else {
      state.shutdown();
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  logger.info(`Mcode v${app.getVersion()} starting`);

  // Ensure mcode data directory exists (~/.mcode or ~/.mcode-dev)
  const mcodeDir = MCODE_DIR;
  mkdirSync(mcodeDir, { recursive: true });

  // Register custom protocol for serving attachment images from disk.
  // URL scheme: mcode-attachment://{threadId}/{attachmentId}.{ext}
  protocol.handle("mcode-attachment", async (request) => {
    const url = new URL(request.url);
    const threadId = url.hostname;
    const filename = url.pathname.replace(/^\//, "");

    // Validate threadId (hex UUID) and filename (hex-uuid.ext)
    if (!VALID_ATTACHMENT_ID.test(threadId)) {
      return new Response("Invalid thread ID", { status: 400 });
    }
    if (!/^[a-f0-9-]+\.\w+$/.test(filename)) {
      return new Response("Invalid attachment ID", { status: 400 });
    }

    const filePath = join(app.getPath("userData"), "attachments", threadId, filename);
    if (!existsSync(filePath)) {
      return new Response("Not found", { status: 404 });
    }

    const ext = filename.split(".").pop() ?? "";
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
      txt: "text/plain",
    };
    const { createReadStream } = await import("fs");
    const { Readable } = await import("stream");
    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    return new Response(webStream, {
      headers: {
        "Content-Type": mimeMap[ext] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  });

  // Initialize AppState with database
  const dbPath = join(mcodeDir, "mcode.db");
  appState = new AppState(dbPath);

  // Create window
  createWindow();

  // Register IPC handlers
  registerIpcHandlers(appState);

  // Start sidecar and set up event forwarding
  try {
    setupEventForwarding(appState);
  } catch (err) {
    logger.error("Failed to start sidecar", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Set up close handler (must happen after window creation)
  setupCloseHandler(appState);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (appState) {
        setupCloseHandler(appState);
      }
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    if (appState) {
      appState.shutdown();
    }
    app.quit();
  }
});

export { mainWindow };
