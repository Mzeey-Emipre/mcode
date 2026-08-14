import { ipcMain, session as electronSession } from "electron";
import type { IpcMain, Session, WebContents } from "electron";
import { BROWSER_TAB_INFO_STRING_MAX } from "@mcode/contracts";
import { registerPreviewClipboardPermissionHandlers } from "./preview-clipboard-trust.js";
import type { PreviewPopupRequest, PreviewPopupSurfaceRef } from "../../features/preview/contracts/popup.js";

/** The single persistent Electron partition shared by every Browser guest. */
export const PREVIEW_PARTITION = "persist:mcode-preview" as const;

/** Bounded host-side popup sink used by a generation-bound guest binding. */
export type PreviewPopupEmitter = (request: PreviewPopupRequest) => void;

/** Agent-operation predicate used to classify the exact popup source guest. */
export type PreviewAgentOperationPredicate = (webContents: WebContents) => boolean;

/** Dependencies that keep the Electron session boundary deterministic in tests. */
export interface PreviewSessionAdapterOptions {
  readonly previewSession?: Session;
  readonly clipboardIpc?: Pick<IpcMain, "on">;
}

/** Options for binding one exact generation-bound guest to popup mediation. */
export interface PreviewGuestPopupBindingOptions {
  readonly sourceSurface: PreviewPopupSurfaceRef;
  readonly emitPopup: PreviewPopupEmitter;
  readonly isAgentOperationActive: PreviewAgentOperationPredicate;
}

const denyPopup = () => ({ action: "deny" as const });

function validPopupAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > BROWSER_TAB_INFO_STRING_MAX.url) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.username.length === 0 &&
    parsed.password.length === 0
  );
}

/** Shared Electron session boundary for Browser policy and generation-bound guest behavior. */
export class PreviewSessionAdapter {
  private readonly previewSessionOverride: Session | undefined;
  private readonly clipboardIpc: Pick<IpcMain, "on">;
  private previewSession: Session | null = null;
  private policySession: Session | null = null;

  /** Creates a session adapter, optionally with deterministic Electron test dependencies. */
  public constructor(options: PreviewSessionAdapterOptions = {}) {
    this.previewSessionOverride = options.previewSession;
    this.clipboardIpc = options.clipboardIpc ?? ipcMain;
  }

  /** Returns the one fixed persistent session used by all Browser guests. */
  public get session(): Session {
    if (!this.previewSession) {
      this.previewSession = this.previewSessionOverride ?? electronSession.fromPartition(PREVIEW_PARTITION);
    }
    return this.previewSession;
  }

  /** Installs partition-wide clipboard and download policy exactly once per session. */
  public registerPolicy(): Session {
    const previewSession = this.session;
    if (this.policySession === previewSession) return previewSession;
    registerPreviewClipboardPermissionHandlers(previewSession, this.clipboardIpc);
    previewSession.on("will-download", (event) => event.preventDefault());
    this.policySession = previewSession;
    return previewSession;
  }

  /** Clears cookies from the shared Browser partition. */
  public clearCookies(): Promise<void> {
    return this.session.clearStorageData({ storages: ["cookies"] });
  }

  /** Clears HTTP cache from the shared Browser partition. */
  public clearCache(): Promise<void> {
    return this.session.clearCache();
  }

  /**
   * Binds one exact guest generation. Electron always receives a deny action;
   * valid HTTP(S) requests are copied into a bounded typed renderer message.
   */
  public bindGuestPopup(
    guest: WebContents,
    options: PreviewGuestPopupBindingOptions,
  ): () => void {
    let bound = true;
    const unbind = () => {
      if (!bound) return;
      bound = false;
      try {
        guest.removeListener("destroyed", onDestroyed);
        if (!guest.isDestroyed()) guest.setWindowOpenHandler(denyPopup);
      } catch {
        // Electron can destroy a guest before release cleanup reaches this adapter.
      }
    };
    const onDestroyed = () => {
      bound = false;
      try {
        guest.removeListener("destroyed", onDestroyed);
      } catch {
        // Guest teardown is already complete.
      }
    };
    guest.setWindowOpenHandler(({ url }: { url: string }) => {
      if (bound && validPopupAddress(url)) {
        try {
          options.emitPopup({
            sourceSurface: options.sourceSurface,
            address: url,
            initiator: options.isAgentOperationActive(guest) ? "agent" : "human",
          });
        } catch {
          // Popup delivery must not bypass Electron's direct-window denial.
        }
      }
      return denyPopup();
    });
    guest.once("destroyed", onDestroyed);
    return unbind;
  }
}

/** Returns the process-wide Browser session adapter used by desktop main. */
export const previewSessionAdapter = new PreviewSessionAdapter();

/** Installs the shared Browser partition policy during desktop startup. */
export function registerPreviewSessionPolicy(): Session {
  return previewSessionAdapter.registerPolicy();
}
