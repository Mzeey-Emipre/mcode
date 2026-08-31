import { useEffect, useReducer, useRef, useState } from "react";
import { useUpdateStore } from "@/stores/updateStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { SectionHeading } from "../SectionHeading";
import { Switch } from "@/components/ui/switch";
import { SegControl } from "../SegControl";
import { Spinner } from "@/components/ui/spinner";
import type { UpdateStatus } from "@/transport/desktop-bridge";
import type { Settings, UpdateCheckInterval, UpdateReleaseLine } from "@mcode/contracts";
import { ConfirmChannelDowngradeDialog } from "./ConfirmChannelDowngradeDialog";
import { semverGt } from "@/lib/semver";

/** Segmented control options for update release line (electron-updater publish channel). */
const RELEASE_LINE_OPTIONS: { value: UpdateReleaseLine; label: string }[] = [
  { value: "stable", label: "Stable" },
  { value: "nightly", label: "Nightly" },
];

function upToDateLabelReducer(_visible: boolean, visible: boolean): boolean {
  return visible;
}

/** Segmented control options for update check frequency. */
const INTERVAL_OPTIONS = [
  { value: "15min", label: "15m" },
  { value: "1hour", label: "1h" },
  { value: "4hours", label: "4h" },
  { value: "1day", label: "1d" },
  { value: "never", label: "Off" },
];

/** How long to hold the "Up to date" label after a check resolves with no update (ms). */
const UP_TO_DATE_HOLD_MS = 4_000;

function getUpdatesHint(checkInterval: UpdateCheckInterval, releaseLine: UpdateReleaseLine): string {
  if (checkInterval === "never") return "Automatic checks disabled.";
  if (releaseLine === "nightly") return "Nightly uses prerelease builds. They may be unstable. Switching back to Stable while running a newer nightly will reinstall the latest stable after confirming.";
  return "Checks for new releases on the configured interval.";
}

function UpdateStatusControl({ status, statusLabel, canCheck, isBusy, onInstall, onCheck }: { status: UpdateStatus; statusLabel: string; canCheck: boolean; isBusy: boolean; onInstall: () => void; onCheck: () => void }) {
  return <div className="flex items-center gap-3">{statusLabel && <span className="font-mono text-xs text-muted-foreground transition-opacity duration-300" aria-live="polite">{statusLabel}</span>}{status.state === "downloaded" ? <button onClick={onInstall} className="rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90">Restart to install</button> : <button onClick={onCheck} disabled={!canCheck || isBusy} className="inline-flex items-center gap-1.5 rounded bg-muted px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40" aria-label={isBusy ? "Checking for updates…" : "Check for updates now"}>{isBusy && <Spinner size={11} className="text-current" />}{isBusy ? "Checking…" : "Check now"}</button>}</div>;
}

function AboutSettingsRows({ version, updatesHint, status, statusLabel, canCheck, isBusy, onInstall, onCheck, releaseLine, onReleaseLineChange, checkInterval, onCheckIntervalChange, autoDownload, onAutoDownloadChange, autoInstallOnQuit, onAutoInstallOnQuitChange }: { version: string | null | undefined; updatesHint: string; status: UpdateStatus; statusLabel: string; canCheck: boolean; isBusy: boolean; onInstall: () => void; onCheck: () => void; releaseLine: UpdateReleaseLine; onReleaseLineChange: (value: UpdateReleaseLine) => void; checkInterval: UpdateCheckInterval; onCheckIntervalChange: (value: UpdateCheckInterval) => void; autoDownload: boolean; onAutoDownloadChange: (value: boolean) => void; autoInstallOnQuit: boolean; onAutoInstallOnQuitChange: (value: boolean) => void }) {
  return <div><SettingRow label="Version" hint="Currently installed build."><span className="font-mono text-xs text-muted-foreground tabular-nums">{version || "—"}</span></SettingRow><SettingRow label="Updates" hint={updatesHint}><UpdateStatusControl status={status} statusLabel={statusLabel} canCheck={canCheck} isBusy={isBusy} onInstall={onInstall} onCheck={onCheck} /></SettingRow><SettingRow label="Release line" hint="Stable follows tagged releases. Nightly follows automated prerelease builds when the project publishes them."><SegControl options={RELEASE_LINE_OPTIONS} value={releaseLine} onChange={(value) => onReleaseLineChange(value as UpdateReleaseLine)} /></SettingRow><SettingRow label="Check interval" hint="How often to poll for new releases. Takes effect on next launch."><SegControl options={INTERVAL_OPTIONS} value={checkInterval} onChange={(value) => onCheckIntervalChange(value as UpdateCheckInterval)} /></SettingRow><SettingRow label="Auto-download" hint="Download updates in the background as soon as they are available."><Switch checked={autoDownload} onCheckedChange={onAutoDownloadChange} /></SettingRow><SettingRow label="Auto-install on quit" hint="Apply downloaded updates automatically when the app closes."><Switch checked={autoInstallOnQuit} onCheckedChange={onAutoInstallOnQuitChange} /></SettingRow></div>;
}

function getUpdatePreferences(settings: Settings): { autoDownload: boolean; autoInstallOnQuit: boolean; checkInterval: UpdateCheckInterval; releaseLine: UpdateReleaseLine } {
  return { autoDownload: settings.updates?.autoDownload ?? true, autoInstallOnQuit: settings.updates?.autoInstallOnQuit ?? true, checkInterval: settings.updates?.checkInterval ?? "4hours", releaseLine: settings.updates?.channel ?? "stable" };
}

function isUpdateBusy(checking: boolean, status: UpdateStatus): boolean {
  return checking || status.state === "checking" || status.state === "downloading";
}

function getUpdateStatusLabel(upToDateLabel: boolean, status: UpdateStatus): string {
  return upToDateLabel ? "Up to date" : describeStatus(status);
}

/**
 * About settings section: shows the running app version, the current
 * auto-updater state, and controls for update behavior.
 *
 * The version is read from the Electron main process at startup, so it
 * always reflects the installed build without manual maintenance.
 */
export function AboutSection() {
  const version = useUpdateStore((s) => s.version);
  const status = useUpdateStore((s) => s.status);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);

  /** True while a manually-triggered check is in flight. */
  const [checking, setChecking] = useState(false);
  /** Transient label shown for UP_TO_DATE_HOLD_MS after "no update" resolves. */
  const [upToDateLabel, setUpToDateLabel] = useReducer(upToDateLabelReducer, false);
  const upToDateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Latest stable version on GitHub, used to decide if nightly→stable is a downgrade. */
  const [latestStable, setLatestStable] = useState<string | null>(null);
  /** When non-null, the dialog is shown for the pending downgrade. */
  const [pendingDowngrade, setPendingDowngrade] = useState<null | {
    currentVersion: string;
    latestStable: string;
  }>(null);

  const bridge = typeof window !== "undefined" ? window.desktopBridge?.app : undefined;

  /** Show the "Up to date" label for a few seconds, then clear it. */
  const flashUpToDate = () => {
    setUpToDateLabel(true);
    if (upToDateTimer.current) clearTimeout(upToDateTimer.current);
    upToDateTimer.current = setTimeout(() => {
      setUpToDateLabel(false);
    }, UP_TO_DATE_HOLD_MS);
  };

  // Any active update state clears the transient "Up to date" label.
  useEffect(() => {
    if (
      status.state === "available" ||
      status.state === "downloading" ||
      status.state === "downloaded"
    ) {
      setUpToDateLabel(false);
      if (upToDateTimer.current) clearTimeout(upToDateTimer.current);
    }
  }, [status.state]);

  // Clean up timer on unmount.
  useEffect(() => () => {
    if (upToDateTimer.current) clearTimeout(upToDateTimer.current);
  }, []);

  // Fetch the latest stable version once on mount. Used only to decide
  // whether nightly → stable is a downgrade. Failure is non-fatal — the
  // downgrade prompt simply won't appear.
  useEffect(() => {
    let cancelled = false;
    fetch("https://api.github.com/repos/mzeey-empire/mcode/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const tag = typeof data.tag_name === "string" ? data.tag_name : null;
        if (!tag) return;
        // Strip leading "v" or "mcode-v" prefix from release-please tags.
        const cleaned = tag.replace(/^mcode-v?/, "").replace(/^v/, "");
        setLatestStable(cleaned);
      })
      .catch(() => {
        // Silent — no downgrade prompt is the only consequence.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCheck = async (): Promise<void> => {
    if (!bridge) return;
    setUpToDateLabel(false);
    setChecking(true);
    try {
      const result = await bridge.checkForUpdates();
      if (result.state === "not-available") {
        flashUpToDate();
      }
    } catch {
      // The main process broadcasts an error status via IPC, which surfaces as
      // status.state === "error" and renders "Check failed" in the status label.
    } finally {
      setChecking(false);
    }
  };

  const handleInstall = async (): Promise<void> => {
    if (!bridge) return;
    try {
      await bridge.installUpdate();
    } catch {
      // installUpdate triggers a quit-and-restart; rejections here are unexpected.
    }
  };

  const { autoDownload, autoInstallOnQuit, checkInterval, releaseLine } = getUpdatePreferences(settings);

  /**
   * Persist the new channel AND tell the main process to switch the running
   * updater. Persistence MUST happen first because the main process's next
   * periodic check re-reads settings.json — see auto-updater.ts.
   */
  const applyChannelSwitch = async (
    next: UpdateReleaseLine,
    allowDowngrade: boolean,
  ): Promise<void> => {
    await updateSettings({ updates: { channel: next } });
    if (bridge?.applyReleaseLine) {
      await bridge.applyReleaseLine({ releaseLine: next, allowDowngrade });
    }
  };

  /**
   * Handle a release-line change from the SegControl. Confirms with the user
   * when switching nightly → stable while running a newer-than-stable build,
   * because that path requires a downgrade install.
   */
  const handleChannelChange = async (next: UpdateReleaseLine): Promise<void> => {
    if (next === releaseLine) return;

    // Conservative: when nightly → stable and we don't yet know latestStable
    // (fetch pending or failed), assume the switch would be a downgrade so the
    // dialog still gates the change. Prevents a fast click from sliding past
    // the confirmation while the network call is in flight.
    const wouldDowngrade =
      releaseLine === "nightly" && next === "stable" && version
        ? !latestStable || semverGt(version, latestStable)
        : false;

    if (wouldDowngrade) {
      setPendingDowngrade({
        currentVersion: version!,
        latestStable: latestStable ?? "the latest stable release",
      });
      return;
    }

    await applyChannelSwitch(next, false);
  };

  const isBusy = isUpdateBusy(checking, status);

  const updatesHint = getUpdatesHint(checkInterval, releaseLine);

  // Derive the inline status label shown beside the button.
  const statusLabel = getUpdateStatusLabel(upToDateLabel, status);

  return (
    <div>
      <SectionHeading>About</SectionHeading>
      <AboutSettingsRows version={version} updatesHint={updatesHint} status={status} statusLabel={statusLabel} canCheck={Boolean(bridge)} isBusy={isBusy} onInstall={() => void handleInstall()} onCheck={() => void handleCheck()} releaseLine={releaseLine} onReleaseLineChange={(value) => void handleChannelChange(value)} checkInterval={checkInterval} onCheckIntervalChange={(value) => void updateSettings({ updates: { checkInterval: value } })} autoDownload={autoDownload} onAutoDownloadChange={(value) => void updateSettings({ updates: { autoDownload: value } })} autoInstallOnQuit={autoInstallOnQuit} onAutoInstallOnQuitChange={(value) => void updateSettings({ updates: { autoInstallOnQuit: value } })} />
      {pendingDowngrade && (
        <ConfirmChannelDowngradeDialog
          currentVersion={pendingDowngrade.currentVersion}
          latestStable={pendingDowngrade.latestStable}
          onCancel={() => setPendingDowngrade(null)}
          onConfirm={async () => {
            await applyChannelSwitch("stable", true);
            setPendingDowngrade(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Short status label shown beside the button.
 * @param status - Current update status from the Electron main process.
 * @returns Human-readable label, or empty string when nothing noteworthy is happening.
 */
function describeStatus(status: UpdateStatus): string {
  switch (status.state) {
    case "idle":
    case "not-available":
      return "";
    case "checking":
      return "Checking…";
    case "available":
      return `v${status.version} available`;
    case "downloading":
      return `${status.percent}%`;
    case "downloaded":
      return `v${status.version} ready`;
    case "error":
      return "Check failed";
  }
}
