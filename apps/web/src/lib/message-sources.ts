import type { Message } from "@mcode/contracts";

/** A deduped external link the assistant referenced during the thread. */
export interface ThreadSource {
  /** The full, canonical URL. Shown on hover and used to open the link. */
  url: string;
  /** HTTPS favicon URL for the host, or null when none can be derived. */
  faviconUrl: string | null;
}

/** Matches HTTP(S) URLs inside message markdown. */
const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g;

/** Trailing characters that markdown/prose commonly appends to a URL. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;

/**
 * Caps how many sources we collect. The Overview is a glanceable surface, not a
 * full bibliography, and the scan runs over every assistant message, so the work
 * stays bounded even on long threads.
 */
const MAX_SOURCES = 32;

/**
 * Derives the favicon URL for an external link, or null for non-HTTPS hosts
 * (favicons are only fetched over HTTPS).
 */
function deriveFaviconUrl(parsed: URL): string | null {
  return parsed.protocol === "https:" ? `${parsed.origin}/favicon.ico` : null;
}

/**
 * Extracts the deduped list of external links the assistant produced across a
 * thread's messages, in first-seen order. Only assistant messages count as
 * sources; user-pasted links are excluded. Deduped by full URL so the same page
 * cited twice appears once. Intended to be computed lazily (only when the
 * Overview is open) so it never runs during streaming.
 */
export function extractThreadSources(
  messages: readonly Pick<Message, "role" | "content">[],
): ThreadSource[] {
  const seen = new Set<string>();
  const sources: ThreadSource[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    const matches = message.content.match(URL_RE);
    if (!matches) continue;

    for (const match of matches) {
      const url = match.replace(TRAILING_PUNCTUATION_RE, "");
      if (seen.has(url)) continue;

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;

      seen.add(url);
      sources.push({ url, faviconUrl: deriveFaviconUrl(parsed) });
      if (sources.length >= MAX_SOURCES) return sources;
    }
  }

  return sources;
}
