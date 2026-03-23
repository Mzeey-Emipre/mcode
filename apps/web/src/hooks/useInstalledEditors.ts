import { useEffect, useState } from "react";
import { getTransport } from "@/transport";

/** Module-level cache so the IPC call only fires once across all mounts. */
let cachedEditors: string[] | null = null;

/**
 * Detects installed code editors via IPC.
 * The result is cached at module level so switching threads
 * does not trigger redundant IPC roundtrips.
 */
export function useInstalledEditors(): string[] {
  const [editors, setEditors] = useState<string[]>(cachedEditors ?? []);

  useEffect(() => {
    if (cachedEditors !== null) return;

    let cancelled = false;
    getTransport()
      .detectEditors()
      .then((result) => {
        cachedEditors = result;
        if (!cancelled) setEditors(result);
      })
      .catch(() => {
        // Detection failed; show no editors (Explorer always available)
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return editors;
}
