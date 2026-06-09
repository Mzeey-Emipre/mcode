import { useEffect, useState } from "react";
import { getTransport } from "@/transport";
import type { OpenInApp } from "@/transport/types";

/** Module-level cache so the IPC call only fires once across all mounts. */
let cachedApps: OpenInApp[] | null = null;

/**
 * Lists openable apps (editors, file manager) with metadata and detection
 * status from the desktop registry. The result is cached at module level so
 * switching threads does not trigger redundant IPC roundtrips.
 */
export function useOpenInApps(): OpenInApp[] {
  const [apps, setApps] = useState<OpenInApp[]>(cachedApps ?? []);

  useEffect(() => {
    if (cachedApps !== null) return;

    let cancelled = false;
    getTransport()
      .listOpenInApps()
      .then((result) => {
        cachedApps = result;
        if (!cancelled) setApps(result);
      })
      .catch(() => {
        // Listing failed; show no apps (Explorer is rendered unconditionally).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return apps;
}
