import { installServerAuthCookie } from "./connection/auth-cookie.js";
import { registerServerConnectionHandlers } from "./connection/handlers.js";
import { startIpcRelay } from "./connection/ipc-relay.js";
import { BusyBlocker } from "./power/busy-blocker.js";
import { ServerManager } from "./process/manager.js";
import { ServerCrashRecovery } from "./recovery/crash-recovery.js";
import { ServerHealthRecovery } from "./recovery/health-recovery.js";
import { ServerNotifications } from "./recovery/notifications.js";
import {
  ReliabilityHarnessControlPlane,
  readReliabilityHarnessCapability,
  type ReliabilityHarnessCommand,
} from "./reliability-harness/control.js";

interface ServerRuntimeWebContents {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

interface ServerRuntimeRecoveryWindow {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

interface ServerRuntimeWindow extends ServerRuntimeRecoveryWindow {
  isDestroyed(): boolean;
  webContents: ServerRuntimeWebContents;
  once(event: "closed", listener: () => void): void;
}

interface ServerRuntimeManager {
  port: number;
  authToken: string;
  ipcPath: string;
  onUnexpectedExit: ((code: number | null) => void) | null;
  start(): Promise<{ port: number; authToken: string }>;
  isHealthy(): Promise<boolean>;
  restart(): Promise<void>;
  restartPlanned?(): Promise<void>;
  forceReplace(): Promise<void>;
}

type ServerRuntimeRelayStarter = (
  ipcPath: string,
  window: ServerRuntimeWindow,
) => () => void;

interface ServerRuntimeDialog {
  showMessageBox(
    window: ServerRuntimeRecoveryWindow,
    options: {
      type: "error";
      title: string;
      message: string;
      buttons: string[];
      defaultId: number;
      cancelId: number;
    },
  ): Promise<{ response: number }>;
}

interface ServerRuntimeNotification {
  on(event: "click", listener: () => void): void;
  show(): void;
}

interface ServerRuntimeDependencies {
  manager?: ServerRuntimeManager;
  relayStarter?: ServerRuntimeRelayStarter;
  ipcMain: {
    handle(
      channel: string,
      listener: (event: { sender: unknown }, ...args: unknown[]) => unknown,
    ): void;
  };
  getMainWindow(): ServerRuntimeWindow | null;
  dialog: ServerRuntimeDialog;
  app: { quit(): void };
  notification: {
    isSupported(): boolean;
    create(options: { title: string; body: string }): ServerRuntimeNotification;
  };
  powerMonitor: {
    on(event: "resume", listener: () => void): void;
  };
  powerSaveBlocker: {
    start(reason: "prevent-app-suspension"): number;
    stop(id: number): void;
  };
  getCookieStore(): {
    set(details: {
      url: string;
      name: string;
      value: string;
      httpOnly: true;
      sameSite: "strict";
    }): Promise<void> | void;
  };
  reliabilityHarnessCapabilityPath?: string;
}

/** Owns server process, connection, recovery, power, and window-transport behavior. */
export class ServerRuntime {
  private readonly serverManager: ServerRuntimeManager;
  private readonly serverNotifications: ServerNotifications;
  private readonly serverCrashRecovery: ServerCrashRecovery;
  private readonly serverHealthRecovery: ServerHealthRecovery;
  private readonly serverBusyBlocker: BusyBlocker;
  private readonly dependencies: ServerRuntimeDependencies;
  private readonly relayStarter: ServerRuntimeRelayStarter;
  private readonly reliabilityHarnessControlPlane: ReliabilityHarnessControlPlane | null;

  constructor(dependencies: ServerRuntimeDependencies) {
    this.dependencies = dependencies;
    this.serverManager = dependencies.manager ?? new ServerManager();
    this.relayStarter = dependencies.relayStarter ?? startIpcRelay;
    const capabilityPath = dependencies.reliabilityHarnessCapabilityPath;
    const capability = capabilityPath ? readReliabilityHarnessCapability(capabilityPath) : null;
    this.reliabilityHarnessControlPlane = capability && capabilityPath
      ? new ReliabilityHarnessControlPlane(capabilityPath, {
        plannedRestart: () => this.restartPlanned(),
        serverFault: (command, token) => this.forwardServerFault(command, token),
      })
      : null;
    this.serverNotifications = new ServerNotifications({
      getMainWindow: dependencies.getMainWindow,
      dialog: dependencies.dialog,
      restart: () => this.serverManager.restart(),
      app: dependencies.app,
      notification: dependencies.notification,
    });
    this.serverCrashRecovery = new ServerCrashRecovery({
      restart: () => this.serverManager.restart(),
      notifyRecovered: (code) =>
        this.serverNotifications.showRecoveredNotification(code),
      showError: (code) => this.serverNotifications.showCrashDialog(code),
    });
    this.serverHealthRecovery = new ServerHealthRecovery({
      isHealthy: () => this.serverManager.isHealthy(),
      restart: () => this.serverManager.restart(),
      showError: () => this.serverNotifications.showCrashDialog(null),
      logger: {
        log: (...args) => console.log(...args),
        error: (...args) => console.error(...args),
      },
    });
    this.serverBusyBlocker = new BusyBlocker({
      blocker: dependencies.powerSaveBlocker,
      log: (...args) => console.log(...args),
    });
  }

  /** Start the server and return its listening port. */
  async start(): Promise<number> {
    const { port } = await this.serverManager.start();
    await this.reliabilityHarnessControlPlane?.start();
    return port;
  }

  /** Register server crash recovery and sleep-resume health recovery. */
  registerLifecycle(): void {
    this.serverManager.onUnexpectedExit = (code) => {
      void this.serverCrashRecovery.handleUnexpectedExit(code);
    };
    this.dependencies.powerMonitor.on("resume", () => {
      void this.serverHealthRecovery.ensureServerRunning();
    });
  }

  /** Register authenticated server connection IPC handlers. */
  registerConnectionHandlers(): void {
    registerServerConnectionHandlers({
      ipcMain: this.dependencies.ipcMain,
      getMainWebContents: () => this.dependencies.getMainWindow()?.webContents ?? null,
      getConnection: () => ({
        port: this.serverManager.port,
        authToken: this.serverManager.authToken,
        ipcPath: this.serverManager.ipcPath,
      }),
      ensureServerRunning: () => this.serverHealthRecovery.ensureServerRunning(),
      reportBusy: (sender, busy) => {
        this.serverBusyBlocker.report(
          sender as Parameters<BusyBlocker["report"]>[0],
          busy,
        );
      },
    });
  }

  /** Install the authenticated cookie for the local server connection. */
  async installAuthCookie(): Promise<void> {
    await installServerAuthCookie(this.dependencies.getCookieStore(), {
      port: this.serverManager.port,
      authToken: this.serverManager.authToken,
    });
  }

  /** Attach the server IPC relay to a window and clean it up after close. */
  attachWindow(window: ServerRuntimeWindow): void {
    if (!this.serverManager.ipcPath) return;

    const cleanupRelay = this.relayStarter(this.serverManager.ipcPath, window);
    window.once("closed", cleanupRelay);
  }

  /** Force-replace the server before an application update or performance cleanup. */
  async forceReplace(): Promise<void> {
    await this.serverManager.forceReplace();
  }

  /** Restart the server under an explicit harness command without crash recovery. */
  async restartPlanned(): Promise<void> {
    if (this.serverManager.restartPlanned) {
      await this.serverManager.restartPlanned();
      return;
    }
    await this.serverManager.restart();
  }

  private async forwardServerFault(command: ReliabilityHarnessCommand, token: string): Promise<void> {
    if (!this.serverManager.port || !this.serverManager.authToken) {
      throw new Error("Server is not ready for reliability control");
    }
    const response = await fetch(`http://127.0.0.1:${this.serverManager.port}/__mcode/reliability`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.serverManager.authToken}`,
        "X-Mcode-Reliability-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Reliability server control failed with HTTP ${response.status}`);
  }

  /** Return the server port used by close confirmation health checks. */
  get port(): number {
    return this.serverManager.port;
  }

  /** Return the active-agent count used by Desktop Window close confirmation. */
  async getActiveAgentCount(): Promise<number> {
    if (!this.serverManager.port) return 0;
    try {
      const response = await fetch(
        `http://localhost:${this.serverManager.port}/health`,
        { signal: AbortSignal.timeout(3_000) },
      );
      if (!response.ok) return 0;
      const payload = (await response.json()) as { activeAgents?: unknown };
      return typeof payload.activeAgents === "number" &&
        Number.isSafeInteger(payload.activeAgents) &&
        payload.activeAgents >= 0
        ? payload.activeAgents
        : 0;
    } catch {
      return 0;
    }
  }
}
