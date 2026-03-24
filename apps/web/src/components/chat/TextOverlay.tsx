// apps/web/src/components/chat/TextOverlay.tsx
import { forwardRef, useMemo } from "react";
import { COMBINED_TOKEN_RE } from "@/lib/file-tags";
import type { Command } from "./useSlashCommand";

type SegmentKind = "plain" | "file" | "slash-skill" | "slash-mcode" | "slash-plugin";

interface Segment {
  text: string;
  kind: SegmentKind;
}

/**
 * Tailwind classes per segment kind.
 *
 * Stronger 20% bg + 1px ring gives a visible "chip" feel through
 * the transparent textarea. The ring uses the same hue at 30% so
 * it reads as a subtle border without competing with the text.
 */
const KIND_CLASSES: Record<Exclude<SegmentKind, "plain">, string> = {
  file: "rounded px-[1px] bg-sky-500/20 ring-1 ring-sky-500/30 text-transparent",
  "slash-skill": "rounded px-[1px] bg-emerald-500/20 ring-1 ring-emerald-500/30 text-transparent",
  "slash-mcode": "rounded px-[1px] bg-primary/20 ring-1 ring-primary/30 text-transparent",
  "slash-plugin": "rounded px-[1px] bg-orange-500/20 ring-1 ring-orange-500/30 text-transparent",
};

interface TextOverlayProps {
  text: string;
  /** Set of file paths that are valid (exist in the file list). */
  validRefs: Set<string>;
  /** Known slash commands for namespace-aware highlighting. */
  knownCommands?: Command[];
}

/**
 * Build a Map<name, namespace> from the command list for O(1) lookup.
 */
function buildCommandMap(commands: Command[]): Map<string, Command["namespace"]> {
  const map = new Map<string, Command["namespace"]>();
  for (let i = 0; i < commands.length; i++) {
    map.set(commands[i].name, commands[i].namespace);
  }
  return map;
}

/**
 * Split text into segments: plain text, highlighted @file references,
 * and highlighted /command tokens with namespace-aware coloring.
 *
 * Single-pass over COMBINED_TOKEN_RE which matches both token types.
 */
export function buildSegments(
  text: string,
  validRefs: Set<string>,
  commandMap: Map<string, Command["namespace"]>,
): Segment[] {
  const hasAt = text.includes("@") && validRefs.size > 0;
  const hasSlash = text.includes("/") && commandMap.size > 0;
  if (!hasAt && !hasSlash) {
    return [{ text, kind: "plain" }];
  }

  COMBINED_TOKEN_RE.lastIndex = 0;
  const segments: Segment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(COMBINED_TOKEN_RE)) {
    const matchStart = match.index!;
    const fileToken = match[1]; // Group 1: @file/path
    const slashToken = match[2]; // Group 2: /command-name

    if (fileToken) {
      // @file reference — highlight only if path is in validRefs
      const refPath = fileToken.slice(1); // strip @
      if (matchStart > lastIndex) {
        segments.push({ text: text.slice(lastIndex, matchStart), kind: "plain" });
      }
      segments.push({
        text: fileToken,
        kind: validRefs.has(refPath) ? "file" : "plain",
      });
      lastIndex = matchStart + fileToken.length;
    } else if (slashToken) {
      // /command — highlight only if it's a known command AND followed by
      // whitespace, end-of-input, or another token boundary (completed token)
      const afterIdx = matchStart + slashToken.length;
      const charAfter = text[afterIdx];
      const isComplete =
        afterIdx >= text.length ||
        charAfter === " " ||
        charAfter === "\n" ||
        charAfter === "\t";

      const cmdName = slashToken.slice(1); // strip /
      const ns = commandMap.get(cmdName);

      if (ns && isComplete) {
        if (matchStart > lastIndex) {
          segments.push({ text: text.slice(lastIndex, matchStart), kind: "plain" });
        }
        segments.push({
          text: slashToken,
          kind: `slash-${ns}` as SegmentKind,
        });
        lastIndex = matchStart + slashToken.length;
      }
      // else: not a known command or not completed — skip, stays as plain text
    }
  }

  // Remaining text after last match
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), kind: "plain" });
  }

  return segments.length === 0 ? [{ text, kind: "plain" }] : segments;
}

/**
 * Transparent overlay that mirrors textarea text and highlights
 * @file and /command tokens with colored backgrounds.
 *
 * Sits behind the textarea (textarea has transparent background).
 * Shares the same font, padding, and dimensions so highlights align.
 */
export const TextOverlay = forwardRef<HTMLDivElement, TextOverlayProps>(
  function TextOverlay({ text, validRefs, knownCommands }, ref) {
    const commandMap = useMemo(
      () => buildCommandMap(knownCommands ?? []),
      [knownCommands],
    );

    const segments = buildSegments(text, validRefs, commandMap);

    return (
      <div
        ref={ref}
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 pt-3 pb-1 text-sm text-transparent"
      >
        {segments.map((seg, i) =>
          seg.kind !== "plain" ? (
            <mark
              key={i}
              className={KIND_CLASSES[seg.kind]}
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
