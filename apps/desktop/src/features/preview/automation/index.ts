import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { BrowserAutomationKernel } from "./kernel.js";
import {
  BROWSER_AUTOMATION_HEARTBEAT_SUBSCRIBE_CHANNEL,
  BrowserAutomationHeartbeatPulse,
} from "./heartbeat-pulse.js";

let kernel: BrowserAutomationKernel | null = null;
const subscribedRenderers = new WeakSet<object>();
const heartbeatPulse = new BrowserAutomationHeartbeatPulse();

/** Registers the bounded high-level IPC surface for visible browser automation. */
export function registerBrowserAutomationHandlers(platform: NodeJS.Platform): void {
  const automationKernel = new BrowserAutomationKernel(platform);
  kernel = automationKernel;
  ipcMain.handle("preview:automation.execute", (event, payload: unknown) => automationKernel.execute(event, payload));
  ipcMain.handle("preview:automation.begin-renderer-operation", (event, payload: unknown) => automationKernel.beginRendererOperation(event, payload));
  ipcMain.handle("preview:automation.finish-renderer-operation", (event, payload: unknown) => automationKernel.finishRendererOperation(event, payload));
  ipcMain.handle("preview:automation.cancel", (_event, requestId: unknown) => automationKernel.cancel(requestId));
  ipcMain.handle("preview:automation.interrupt", (event, target: unknown) => automationKernel.interrupt(event, target));
  ipcMain.handle("preview:automation.release-agent-control", (event, target: unknown) => automationKernel.releaseAgentControl(event, target));
  ipcMain.handle("preview:automation.describe-target", (event, target: unknown) => automationKernel.describeTarget(event, target));
  ipcMain.handle("preview:automation.media-source", (event, target: unknown) => automationKernel.getMediaSourceId(event, target));
  ipcMain.handle("preview:open-guest-devtools", (event, target: unknown) => automationKernel.openDevTools(event, target));
  ipcMain.on("preview:automation.subscribe", (event: IpcMainEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (subscribedRenderers.has(event.sender)) return;
    subscribedRenderers.add(event.sender);
    const unsubscribe = automationKernel.subscribe(win.id, (state) => {
      if (!event.sender.isDestroyed()) event.sender.send("preview:automation.controller", state);
    });
    event.sender.once("destroyed", unsubscribe);
  });
  ipcMain.on(BROWSER_AUTOMATION_HEARTBEAT_SUBSCRIBE_CHANNEL, (event: IpcMainEvent) => {
    heartbeatPulse.subscribe(event.sender);
  });
}

/** Disposes browser automation resources owned by one closing BrowserWindow. */
export function disposeBrowserAutomationForWindow(windowId: number): void {
  kernel.disposeWindow(windowId);
}

/** Returns bounded automation counters for diagnostics and stress tests. */
export function getBrowserAutomationCounters(): ReturnType<BrowserAutomationKernel["getCounters"]> {
  return kernel.getCounters();
}
