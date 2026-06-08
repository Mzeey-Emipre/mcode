import { useState } from "react";
import { Loader2, ArrowUpCircle } from "lucide-react";
import { useUpdateStore } from "@/stores/updateStore";

/**
 * Quiet auto-updater affordance that lives in the sidebar footer. Renders
 * nothing at rest and only for the actionable states (available, downloading,
 * downloaded); errors surface as non-blocking toasts instead. Replaces the
 * former full-width colored header banner with an instrument-strip treatment
 * that matches the sidebar's density and amber-primary accent.
 */
export function UpdateIndicator() {
  const status = useUpdateStore((s) => s.status);
  const dismissed = useUpdateStore((s) => s.bannerDismissed);
  const dismiss = useUpdateStore((s) => s.dismissBanner);
  const [busy, setBusy] = useState(false);

  if (!window.desktopBridge) return null;
  if (dismissed) return null;

  if (status.state === "downloading") {
    return (
      <div className="space-y-1.5 px-1.5 py-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 size={11} className="animate-spin text-primary" aria-hidden="true" />
            Downloading update
          </span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground/45">
            {status.percent}%
          </span>
        </div>
        <div
          className="h-[2px] w-full rounded-full bg-border/40"
          role="progressbar"
          aria-label="Update download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={status.percent}
        >
          <div
            className="h-[2px] rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${status.percent}%` }}
          />
        </div>
      </div>
    );
  }

  if (status.state === "available") {
    const handleDownload = async () => {
      setBusy(true);
      try {
        await window.desktopBridge?.app.downloadUpdate();
      } catch {
        // A failure broadcasts an error status over IPC, surfaced as a toast.
      } finally {
        setBusy(false);
      }
    };

    return (
      <div className="flex items-center justify-between gap-2 px-1.5 py-1">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
          <span className="truncate">Update available</span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground/40">
            v{status.version}
          </span>
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={() => void handleDownload()}
            disabled={busy}
            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
          >
            {busy ? "Downloading…" : "Download"}
          </button>
          <button
            onClick={dismiss}
            aria-label="Dismiss update notice"
            className="rounded px-1 py-0.5 text-[11px] text-muted-foreground/60 transition-colors hover:text-foreground"
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  if (status.state === "downloaded") {
    const handleRestart = async () => {
      setBusy(true);
      try {
        const started = await window.desktopBridge?.app.installUpdate();
        // Clear loading state if install was a no-op (dev mode, stale state).
        if (!started) setBusy(false);
      } catch {
        setBusy(false);
      }
    };

    return (
      <button
        onClick={() => void handleRestart()}
        disabled={busy}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-primary/25 bg-primary/10 px-2 py-1.5 text-left transition-colors hover:bg-primary/15 disabled:opacity-60"
      >
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-primary">
          {busy ? (
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          ) : (
            <ArrowUpCircle size={12} aria-hidden="true" />
          )}
          <span className="truncate">{busy ? "Restarting…" : "Restart to update"}</span>
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-primary/70">
          v{status.version}
        </span>
      </button>
    );
  }

  return null;
}
