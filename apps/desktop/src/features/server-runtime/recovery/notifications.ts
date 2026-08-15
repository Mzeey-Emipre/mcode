interface ServerRecoveryWindow {
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
}

interface ServerCrashDialogOptions {
  type: "error";
  title: string;
  message: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

interface ServerRecoveryNotification {
  on: (event: "click", listener: () => void) => void;
  show: () => void;
}

interface ServerNotificationsDeps {
  getMainWindow: () => ServerRecoveryWindow | null;
  dialog: {
    showMessageBox: (
      window: ServerRecoveryWindow,
      options: ServerCrashDialogOptions,
    ) => Promise<{ response: number }>;
  };
  restart: () => Promise<void>;
  app: { quit: () => void };
  notification: {
    isSupported: () => boolean;
    create: (options: { title: string; body: string }) => ServerRecoveryNotification;
  };
}

/** Owns server crash dialogs and recovered notifications. */
export class ServerNotifications {
  private readonly getMainWindow: () => ServerRecoveryWindow | null;
  private readonly dialog: ServerNotificationsDeps["dialog"];
  private readonly restart: () => Promise<void>;
  private readonly app: ServerNotificationsDeps["app"];
  private readonly notification: ServerNotificationsDeps["notification"];

  constructor(deps: ServerNotificationsDeps) {
    this.getMainWindow = deps.getMainWindow;
    this.dialog = deps.dialog;
    this.restart = deps.restart;
    this.app = deps.app;
    this.notification = deps.notification;
  }

  async showCrashDialog(code: number | null): Promise<void> {
    const mainWindow = this.getMainWindow();
    if (!mainWindow) return;

    const { response } = await this.dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Server crashed",
      message: `The Mcode server exited unexpectedly (code ${code ?? "unknown"}).`,
      buttons: ["Restart", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      await this.restart();
    } else {
      this.app.quit();
    }
  }

  showRecoveredNotification(code: number | null): void {
    if (!this.notification.isSupported()) return;

    const notification = this.notification.create({
      title: "Mcode server recovered",
      body: `The backend crashed (code ${code ?? "unknown"}) and restarted.`,
    });
    notification.on("click", () => {
      const mainWindow = this.getMainWindow();
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    notification.show();
  }
}
