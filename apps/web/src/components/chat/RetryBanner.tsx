import { useThreadRecord } from "@/stores/thread-selectors";

export function RetryBanner({ threadId }: { threadId: string }) {
  const rateLimit = useThreadRecord(threadId, (r) => r.rateLimit);
  const apiRetry = useThreadRecord(threadId, (r) => r.apiRetry);

  if (!rateLimit && !apiRetry) return null;

  const label = rateLimit
    ? formatRateLimitLabel(rateLimit.retryAfterMs)
    : apiRetry
      ? formatApiRetryLabel(apiRetry)
      : null;
  if (!label) return null;

  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 px-3 py-2 border-t border-border/20">
      <span className="relative flex h-3 w-3 shrink-0">
        <span className="motion-safe:animate-ping motion-reduce:hidden absolute inline-flex h-full w-full rounded-full bg-amber-500/60" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500" />
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function formatRateLimitLabel(retryAfterMs: number | null | undefined): string {
  if (!retryAfterMs || retryAfterMs <= 0) return "Rate limited - waiting for capacity...";
  return `Rate limited - retrying in ${formatDuration(Math.ceil(retryAfterMs / 1000))}`;
}

function formatApiRetryLabel(retry: { attempt?: number | null; maxRetries?: number | null; delayMs?: number | null }): string {
  return ["Retrying", formatRetryAttempt(retry), formatRetryDelay(retry.delayMs)]
    .filter(Boolean)
    .join(" ") + "...";
}

function formatRetryAttempt(retry: { attempt?: number | null; maxRetries?: number | null }): string | null {
  if (retry.attempt == null) return null;
  return retry.maxRetries == null ? `(attempt ${retry.attempt})` : `(${retry.attempt}/${retry.maxRetries})`;
}

function formatRetryDelay(delayMs: number | null | undefined): string | null {
  if (!delayMs || delayMs <= 0) return null;
  return `in ${formatDuration(Math.ceil(delayMs / 1000))}`;
}

/** Format seconds into a compact human-readable duration (e.g. "12s", "2m 30s"). */
function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
