const SERVER_CONNECTION_AUTHORIZATION_ERROR =
  "Server connection requires the main renderer";

interface IpcMain {
  handle(
    channel: string,
    listener: (event: IpcEvent, ...args: unknown[]) => unknown,
  ): void;
}

interface IpcEvent {
  sender: unknown;
}

interface ServerConnection {
  port: number;
  authToken: string;
  ipcPath: string;
}

interface ServerConnectionHandlerDependencies {
  ipcMain: IpcMain;
  getMainWebContents: () => unknown;
  getConnection: () => ServerConnection;
  ensureServerRunning: () => Promise<void>;
  reportBusy: (sender: unknown, busy: boolean) => void;
}

function requireMainRenderer(
  event: IpcEvent,
  getMainWebContents: () => unknown,
): void {
  const mainWebContents = getMainWebContents();
  if (!mainWebContents || event.sender !== mainWebContents) {
    throw new Error(SERVER_CONNECTION_AUTHORIZATION_ERROR);
  }
}

/** Register the authenticated server connection handlers for the main renderer. */
export function registerServerConnectionHandlers({
  ipcMain,
  getMainWebContents,
  getConnection,
  ensureServerRunning,
  reportBusy,
}: ServerConnectionHandlerDependencies): void {
  ipcMain.handle("get-server-url", (event) => {
    requireMainRenderer(event, getMainWebContents);
    const { port, authToken, ipcPath } = getConnection();
    return {
      url: `ws://localhost:${port}?token=${authToken}`,
      ipcPath,
    };
  });

  ipcMain.handle("ensure-server-running", async (event) => {
    requireMainRenderer(event, getMainWebContents);
    await ensureServerRunning();
  });

  ipcMain.handle("set-server-busy", (event, ...args: unknown[]) => {
    requireMainRenderer(event, getMainWebContents);
    const busy = args[0];
    if (typeof busy !== "boolean") {
      throw new Error("Server busy state must be a boolean");
    }
    reportBusy(event.sender, busy);
  });
}
