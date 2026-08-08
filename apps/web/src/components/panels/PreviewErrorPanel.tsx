import {
  ArrowLeft,
  FileX,
  RefreshCw,
  ServerCrash,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import type { PreviewPageError } from "@mcode/contracts";
import { Button } from "@/components/ui/button";

/** Per-kind glyph for the error headline. */
const ERROR_ICON: Record<PreviewPageError["kind"], LucideIcon> = {
  http: TriangleAlert,
  network: WifiOff,
  "file-not-found": FileX,
  crash: ServerCrash,
};

/** Props for {@link PreviewErrorPanel}. */
export interface PreviewErrorPanelProps {
  /** Classified failure that put the preview into its error phase. */
  readonly error: PreviewPageError;
  /** URL that failed to load; shown as diagnostic context under the headline. */
  readonly url: string | null;
  /** Whether the guest has back history; gates the secondary "Go back" action. */
  readonly canBack: boolean;
  /** Reload the failed page. */
  readonly onRetry: () => void;
  /** Navigate the guest back one entry. */
  readonly onGoBack: () => void;
}

/**
 * Error surface shown when a Browser page fails to load. Names the failure in
 * plain language, shows the diagnostic code and URL, and offers Retry plus Go
 * back when there is history to return to.
 *
 * Editing the address and opening in the system browser are intentionally NOT
 * here: the omnibox directly above is the URL editor, and the toolbar already
 * owns "Open in system browser" (which is meaningless on an unreachable site).
 */
export function PreviewErrorPanel({
  error,
  url,
  canBack,
  onRetry,
  onGoBack,
}: PreviewErrorPanelProps) {
  const Icon = ERROR_ICON[error.kind];
  // HTTP failures lead with the status; network/file failures with the
  // Chromium net-error code. The dev audience uses this to triage.
  const diagnostic = error.status ? String(error.status) : (error.code ?? null);
  // Join only the present parts so the line never trails a dangling separator
  // when one side is absent (a crash has no status/code; a provisional failure
  // never committed a URL).
  const diagnosticLine = [diagnostic, url].filter(Boolean).join(" \u00b7 ");
  return (
    <div
      data-testid="preview-error-panel"
      role="alert"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center motion-safe:animate-in motion-safe:fade-in"
    >
      {/* Clay-tinted per the system's errored-state color (matches the sidebar
          thread dot and the omnibox navError line) so the failure registers at
          a glance, kept muted to stay quiet rather than a loud alert chip. */}
      <Icon className="size-8 text-destructive/70" aria-hidden />
      <div className="space-y-1">
        <p
          data-testid="preview-error-headline"
          className="text-sm font-medium text-foreground"
        >
          {error.message}
        </p>
        {diagnosticLine ? (
          <p className="max-w-md truncate font-mono text-[11px] text-muted-foreground">
            {diagnosticLine}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Button size="sm" onClick={onRetry} data-testid="preview-error-retry">
          <RefreshCw aria-hidden />
          Retry
        </Button>
        {canBack ? (
          <Button size="sm" variant="outline" onClick={onGoBack}>
            <ArrowLeft aria-hidden />
            Go back
          </Button>
        ) : null}
      </div>
    </div>
  );
}
