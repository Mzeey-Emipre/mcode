// apps/web/src/components/chat/TextOverlay.tsx
import { forwardRef } from "react";
import { HIGHLIGHT_RE } from "@/lib/file-tags";

interface TextOverlayProps {
  text: string;
  /** Set of file paths that are valid (exist in the file list). */
  validRefs: Set<string>;
}

interface Segment {
  text: string;
  highlighted: boolean;
}

/**
 * Split text into segments: plain text and highlighted @path references.
 * Only highlights references that exist in the validRefs set.
 */
function buildSegments(text: string, validRefs: Set<string>): Segment[] {
  if (validRefs.size === 0 || !text.includes("@")) {
    return [{ text, highlighted: false }];
  }

  HIGHLIGHT_RE.lastIndex = 0;
  const segments: Segment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(HIGHLIGHT_RE)) {
    const matchStart = match.index!;
    const matchText = match[1]; // The @path text
    const refPath = matchText.slice(1); // Remove the @

    // Add text before this match
    if (matchStart > lastIndex) {
      segments.push({ text: text.slice(lastIndex, matchStart), highlighted: false });
    }

    // Highlight only if the path is in validRefs
    segments.push({
      text: matchText,
      highlighted: validRefs.has(refPath),
    });
    lastIndex = matchStart + matchText.length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), highlighted: false });
  }

  return segments.length === 0 ? [{ text, highlighted: false }] : segments;
}

/**
 * Transparent overlay that mirrors textarea text and highlights
 * @path tokens with colored backgrounds.
 *
 * Sits behind the textarea (textarea has transparent background).
 * Shares the same font, padding, and dimensions so highlights align.
 */
export const TextOverlay = forwardRef<HTMLDivElement, TextOverlayProps>(
  function TextOverlay({ text, validRefs }, ref) {
    const segments = buildSegments(text, validRefs);

    return (
      <div
        ref={ref}
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 pt-3 pb-1 text-sm text-transparent"
      >
        {segments.map((seg, i) =>
          seg.highlighted ? (
            <mark
              key={i}
              className="rounded-sm bg-primary/15 text-transparent"
            >
              {seg.text}
            </mark>
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
      </div>
    );
  },
);
