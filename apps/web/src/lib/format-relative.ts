/** Format an ISO timestamp as a short relative label, e.g. "just now", "6m ago", "3h ago", "2d ago". */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "just now";
  // Floor each unit so a label never rounds up into the next unit before the
  // boundary is actually reached (e.g. 59m must not read as "1h ago").
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
