/**
 * VSCode icon resolver with Lucide fallback.
 *
 * Resolves file-type icons from the VSCode icons CDN (jsDelivr).
 * Falls back to Lucide icons for offline/unknown cases.
 */
import { getIconForFile } from "vscode-icons-js";
import { getFileIcon } from "./file-icons";
import type { LucideIcon } from "lucide-react";

const CDN_BASE = "https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons/icons";

/** Icon name returned by vscode-icons-js for unrecognized files. */
const DEFAULT_ICON = "default_file.svg";

/** Get the jsDelivr CDN URL for a file's VSCode icon, or null if unknown. */
export function getIconUrl(fileName: string): string | null {
  const iconName = getIconForFile(fileName);
  if (!iconName || iconName === DEFAULT_ICON) return null;
  return `${CDN_BASE}/${iconName}`;
}

export type ResolvedIcon =
  | { readonly type: "vscode"; readonly url: string }
  | { readonly type: "lucide"; readonly icon: LucideIcon };

/** Cache for resolved icon blob URLs. */
const blobCache = new Map<string, string>();

/** Cache for failed lookups to avoid retrying. */
const failedCache = new Set<string>();

/** In-flight fetch deduplication: prevents N identical mentions from triggering N fetches. */
const inflightFetches = new Map<string, Promise<ResolvedIcon>>();

/** Clear all caches (for testing). */
export function clearIconCache(): void {
  blobCache.clear();
  failedCache.clear();
  inflightFetches.clear();
}

/**
 * Resolve the best icon for a filename.
 * Tries VSCode icon from CDN first, falls back to Lucide.
 */
export async function resolveIcon(fileName: string): Promise<ResolvedIcon> {
  const cached = blobCache.get(fileName);
  if (cached) return { type: "vscode", url: cached };

  if (failedCache.has(fileName)) {
    return { type: "lucide", icon: getFileIcon(fileName) };
  }

  const cdnUrl = getIconUrl(fileName);
  if (!cdnUrl) {
    failedCache.add(fileName);
    return { type: "lucide", icon: getFileIcon(fileName) };
  }

  // Deduplicate in-flight fetches for the same file
  const inflight = inflightFetches.get(fileName);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<ResolvedIcon> => {
    try {
      const response = await fetch(cdnUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      blobCache.set(fileName, blobUrl);
      return { type: "vscode", url: blobUrl };
    } catch {
      failedCache.add(fileName);
      return { type: "lucide", icon: getFileIcon(fileName) };
    } finally {
      inflightFetches.delete(fileName);
    }
  })();

  inflightFetches.set(fileName, fetchPromise);
  return fetchPromise;
}
