import { useEffect, useState } from "react";
import { getTransport } from "@/transport";

/**
 * Detects installed code editors via IPC.
 * Calls `detect-editors` once on mount and caches the result.
 */
export function useInstalledEditors(): string[] {
  const [editors, setEditors] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    getTransport()
      .detectEditors()
      .then((result) => {
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
