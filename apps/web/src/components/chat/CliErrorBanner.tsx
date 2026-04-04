import { useState, useCallback } from "react";
import { TriangleAlert, Copy, Check, X, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

/** Error message prefix that identifies a CLI-not-found error from the provider. */
const CLI_NOT_FOUND_MARKERS = ["CLI not found", "not found at"];

/** Extract an install command from the error message, if present. */
function extractInstallCommand(error: string): string | null {
  const match = error.match(/npm install[^\n]+/);
  return match ? match[0] : null;
}

/** Returns true when the error string represents a missing CLI binary. */
export function isCliError(error: string): boolean {
  return CLI_NOT_FOUND_MARKERS.some((m) => error.includes(m));
}

interface CliErrorBannerProps {
  /** The full error string from session.error. */
  error: string;
  /** Called when the user dismisses the banner. */
  onDismiss: () => void;
  /** Called when the user clicks "Open Settings". */
  onOpenSettings: () => void;
}

/**
 * Banner shown above the composer when a provider CLI binary is not found.
 * Displays a clear setup instruction, copyable install command, and a link
 * to the CLI path settings.
 */
export function CliErrorBanner({ error, onDismiss, onOpenSettings }: CliErrorBannerProps) {
  const [copied, setCopied] = useState(false);
  const installCmd = extractInstallCommand(error);

  // Headline: first line of the error. Body: everything after the first blank line.
  const lines = error.split("\n");
  const headline = lines[0];
  const settingsHint = lines.find((l) => l.includes("Settings"));

  const handleCopy = useCallback(async () => {
    if (!installCmd) return;
    try {
      await navigator.clipboard.writeText(installCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable
    }
  }, [installCmd]);

  return (
    <div
      role="alert"
      className={cn(
        "mx-3 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06]",
        "px-4 py-3",
      )}
    >
      <div className="flex items-start gap-3">
        <TriangleAlert
          size={15}
          className="mt-0.5 shrink-0 text-amber-500/80"
          aria-hidden
        />

        <div className="min-w-0 flex-1 space-y-2">
          {/* Headline */}
          <p className="text-xs font-semibold text-foreground/90">{headline}</p>

          {/* Install command */}
          {installCmd && (
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted/60 px-2.5 py-1 font-mono text-[11px] text-foreground/80 border border-border/40">
                {installCmd}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                title="Copy command"
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border/40",
                  "text-muted-foreground/60 transition-colors hover:border-amber-500/40",
                  "hover:bg-amber-500/10 hover:text-amber-500/80",
                )}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
          )}

          {/* Settings hint */}
          {settingsHint && (
            <p className="text-[11px] text-muted-foreground/70">
              {settingsHint.replace(/Settings > Provider > [^\s.]+( CLI path)?\.?/, "").trim()}{" "}
              <button
                type="button"
                onClick={onOpenSettings}
                className="inline-flex items-center gap-1 text-amber-500/80 underline-offset-2 hover:underline"
              >
                <Settings size={10} />
                Open Settings
              </button>
            </p>
          )}
        </div>

        {/* Dismiss */}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:bg-muted/40 hover:text-muted-foreground/70"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
