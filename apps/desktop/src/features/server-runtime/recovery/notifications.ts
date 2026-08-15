/** Window operations required by server recovery feedback. */
export interface ServerRecoveryWindow {
  /** Return whether the window is minimized. */
  isMinimized: () => boolean;
  /** Restore a minimized window. */
  restore: () => void;
  /** Show the window. */
  show: () => void;
  /** Focus the window. */
  focus: () => void;
}

/** Native dialog options used for the server crash decision. */
export interface ServerCrashDialogOptions {
  /** Dialog severity. */
  type: "error";
  /** Dialog title. */
  title: string;
  /** Dialog message. */
  message: string;
  /** Ordered decision buttons. */
  buttons: string[];
  /** Default button index. */
  defaultId: number;
  /** Cancel button index. */
  cancelId: number;
}

/** Native notification instance required by server recovery feedback. */
export interface ServerRecoveryNotification {
  /** Register the notification click handler. */
  on: (event: "click", listener: () => void) => void;
  /** Show the notification. */
  show: () => void;
}

/** Electron boundaries required by {@link ServerNotifications}. */
export interface ServerNotificationsDeps {
  /** Resolve the current main window at operation time. */
  getMainWindow: () => ServerRecoveryWindow | null;
  /** Show the crash decision dialog. */
  dialog: {
    showMessageBox: (
      window: ServerRecoveryWindow,
      options: ServerCrashDialogOptions,
    ) => Promise<{ response: number }>;
  };
  /** Restart the managed server after the user chooses Restart. */
  restart: () => Promise<void>;
  /** Quit the application after the user chooses Quit. */
  app: { quit: () => void };
  /** Construct and support-check native notifications. */
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

  /** Show the Restart or Quit decision for an unrecovered server. */
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

  /** Show a recovered notification and restore the main window when clicked. */
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
