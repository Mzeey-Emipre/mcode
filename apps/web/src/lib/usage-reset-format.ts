/** Formats a quota reset timestamp for compact usage surfaces. */
export function formatUsageResetText(
  resetDate: string | null | undefined,
  now = new Date(),
): string | null {
  if (!resetDate) return null;
  const reset = new Date(resetDate);
  const resetMs = reset.getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;

  const diffMinutes = Math.max(1, Math.ceil((resetMs - nowMs) / 60_000));
  const days = Math.floor(diffMinutes / 1_440);
  const hours = Math.floor((diffMinutes % 1_440) / 60);
  const minutes = diffMinutes % 60;
  const relative =
    days > 0
      ? `${days}d ${hours}h`
      : hours > 0
        ? `${hours}h ${minutes}m`
        : `${minutes}m`;
  const exact = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(reset);

  return `Resets in ${relative} · ${exact}`;
}
