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

import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { isAbsolute, join } from "path";
import { existsSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { AppState } from "./app-state.js";
import { sessionIdFromEvent } from "./sidecar/types.js";
import type { SidecarEvent } from "./sidecar/types.js";
import * as MessageRepo from "./repositories/message-repo.js";
import { logger, getLogPath, getRecentLogs } from "./logger.js";

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

    // Track session lifecycle
    if (event.method === "session.message") {
      state.trackSessionStarted(threadId);
    }
    if (
      event.method === "session.turnComplete" ||
      event.method === "session.ended"
    ) {
      state.trackSessionEnded(threadId);
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
    async (_event, threadId: string, content: string, model?: string, permissionMode?: string) => {
      const validModes = new Set(["full", "supervised", "default"]);
      const mode = validModes.has(permissionMode ?? "") ? permissionMode! : "default";
      await state.sendMessage(threadId, content, mode, model);
    },
  );

  // -- Lazy thread creation --
  ipcMain.handle(
    "create-and-send-message",
    async (_event, workspaceId: string, content: string, model: string, permissionMode?: string, mode?: string, branch?: string) => {
      const validModes = new Set(["full", "supervised", "default"]);
      const safePermission = validModes.has(permissionMode ?? "") ? permissionMode! : "default";
      return state.createAndSendMessage(
        workspaceId, content, model,
        safePermission,
        (mode as "direct" | "worktree") ?? "direct",
        branch ?? "main",
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

  // Ensure ~/.mcode/ directory exists
  const mcodeDir = join(homedir(), ".mcode");
  mkdirSync(mcodeDir, { recursive: true });

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
