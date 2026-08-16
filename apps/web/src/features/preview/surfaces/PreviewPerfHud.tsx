import { useEffect, useState } from "react";
import type { BrowserPerfCounters } from "@mcode/contracts";

/**
 * Floating dev HUD for the embedded browser's perf counters. Gated behind
 * the `previewPerf=1` query param so it never ships in normal UI but is one
 * keystroke away during regressions. Polls once per second; never throws if
 * the desktop bridge is unavailable (web-only build).
 */
export function PreviewPerfHud() {
  const [counters, setCounters] = useState<BrowserPerfCounters | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      setVisible(p.get("previewPerf") === "1");
    } catch {
      setVisible(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    const tick = () => {
      const fn = window.desktopBridge?.preview?.getPerfCounters;
      if (!fn) return;
      void fn().then(
        (c) => setCounters(c),
        () => {
          /* swallow; the panel may not be mounted */
        },
      );
    };
    tick();
    const handle = window.setInterval(tick, 1000);
    return () => window.clearInterval(handle);
  }, [visible]);

  if (!visible || !counters) return null;

  return (
    <div
      data-testid="preview-perf-hud"
      className="pointer-events-auto fixed right-2 bottom-2 z-50 max-w-[18rem] rounded-md border border-border/40 bg-background/95 px-2 py-1.5 font-mono text-[10px] leading-tight shadow"
    >
      <div className="mb-1 font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        preview perf
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0">
        {(Object.entries(counters) as Array<[keyof BrowserPerfCounters, number]>).map(
          ([k, v]) => (
            <div key={k} className="contents">
              <dt className="truncate text-muted-foreground">{k}</dt>
              <dd className="tabular-nums">{v}</dd>
            </div>
          ),
        )}
      </dl>
    </div>
  );
}
