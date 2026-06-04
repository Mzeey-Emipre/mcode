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
 * In-chrome error surface shown (Approach A) when the native preview view is
 * hidden because a load failed. Names the failure in plain language, shows the
 * diagnostic code/URL for triage, and offers the one canonical recovery —
 * Retry — plus Go back when there is history to return to.
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
  return (
    <div
      data-testid="preview-error-panel"
      role="alert"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <Icon className="size-8 text-muted-foreground/40" aria-hidden />
      <div className="space-y-1">
        <p
          data-testid="preview-error-headline"
          className="text-sm font-medium text-foreground"
        >
          {error.message}
        </p>
        {url || diagnostic ? (
          <p className="max-w-md truncate font-mono text-[11px] text-muted-foreground">
            {diagnostic ? `${diagnostic} \u00b7 ` : ""}
            {url}
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
