import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUiStore } from "@/stores/uiStore";
import { getAllCommands } from "@/lib/command-registry";
import {
  getKeybindingForCommand,
  formatKeybinding,
} from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import { Kbd } from "@/components/palette/Kbd";

/** Single shortcut entry as rendered in the dialog. */
interface ShortcutRow {
  /** Stable react key — derived from command id (or a synthetic id for collapsed rows). */
  key: string;
  /** Human-readable command title. */
  title: string;
  /**
   * Pre-split keybinding pieces, in display order. For combos like "Ctrl+K" this is
   * `["Ctrl", "K"]`; for ranges like the Go-to-thread block it's `[...modifiers, "1", "9"]`.
   */
  pieces: string[];
}

/**
 * Categories render in this order. Anything not listed falls through to
 * alphabetical order at the end. Keeps the dialog visually predictable.
 */
const CATEGORY_ORDER = ["Project", "Thread", "Navigation", "View", "Help"];

/** Strip surrounding whitespace and split a formatted keybinding on the `+` separator. */
function splitCombo(shortcut: string): string[] {
  return shortcut
    .split("+")
    .map((piece) => piece.trim())
    .filter(Boolean);
}

type GoToThreadCandidate = Pick<ShortcutRow, "title" | "pieces"> & {
  digit: string;
  category: string;
};

function isUniformGoToThread(candidates: readonly GoToThreadCandidate[]): boolean {
  const first = candidates[0];
  if (!first || candidates.length !== 9) return false;
  const sharedModifiers = first.pieces.slice(0, -1).join("+");
  return candidates.every((candidate, index) =>
    candidate.digit === String(index + 1) &&
    candidate.category === first.category &&
    candidate.pieces.length >= 2 &&
    candidate.pieces.slice(0, -1).join("+") === sharedModifiers &&
    candidate.pieces[candidate.pieces.length - 1] === String(index + 1),
  );
}

function addShortcutRow(map: Map<string, ShortcutRow[]>, category: string, row: ShortcutRow): void {
  const group = map.get(category) ?? [];
  group.push(row);
  map.set(category, group);
}

function addGoToThreadRows(map: Map<string, ShortcutRow[]>, candidates: GoToThreadCandidate[]): void {
  if (isUniformGoToThread(candidates)) {
    const first = candidates[0]!;
    addShortcutRow(map, first.category, {
      key: "thread.goTo.range",
      title: "Go to thread",
      pieces: [...first.pieces.slice(0, -1), "1", "9"],
    });
    return;
  }
  for (const candidate of candidates) {
    addShortcutRow(map, candidate.category, {
      key: `thread.goTo${candidate.digit}`,
      title: candidate.title,
      pieces: candidate.pieces,
    });
  }
}

function buildShortcutGroups(): Map<string, ShortcutRow[]> {
  const hidden = new Set(["escape.handle"]);
  const rowsByCategory = new Map<string, ShortcutRow[]>();
  const goToThreadCandidates: GoToThreadCandidate[] = [];
  const goToThreadPattern = /^thread\.goTo([1-9])$/;

  for (const command of getAllCommands()) {
    if (hidden.has(command.id)) continue;
    const binding = getKeybindingForCommand(command.id);
    if (!binding) continue;
    const pieces = splitCombo(formatKeybinding(binding.key, isMac));
    const goToMatch = goToThreadPattern.exec(command.id);
    if (goToMatch) {
      goToThreadCandidates.push({ digit: goToMatch[1], title: command.title, category: command.category, pieces });
      continue;
    }
    addShortcutRow(rowsByCategory, command.category, { key: command.id, title: command.title, pieces });
  }
  addGoToThreadRows(rowsByCategory, goToThreadCandidates);
  for (const rows of rowsByCategory.values()) rows.sort((left, right) => left.title.localeCompare(right.title));
  return rowsByCategory;
}

/**
 * Full-screen dialog showing all keyboard shortcuts grouped by category.
 * Accessible via Cmd+? or from the command palette.
 */
export function ShortcutHelpDialog() {
  const open = useUiStore((s) => s.shortcutHelpOpen);
  const setOpen = useUiStore((s) => s.setShortcutHelpOpen);

  const grouped = useMemo(() => {
    if (!open) return new Map<string, ShortcutRow[]>();
    return buildShortcutGroups();
  }, [open]);

  const orderedCategories = useMemo(() => {
    const present = Array.from(grouped.keys());
    const known = CATEGORY_ORDER.filter((c) => present.includes(c));
    const unknown = present.filter((c) => !CATEGORY_ORDER.includes(c)).sort();
    return [...known, ...unknown];
  }, [grouped]);

  const totalCount = useMemo(() => {
    let total = 0;
    for (const rows of grouped.values()) total += rows.length;
    return total;
  }, [grouped]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => setOpen(nextOpen)}>
      <DialogContent
        className="flex max-h-[85vh] w-full max-w-xl flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton
      >
        {/* Sticky header — editorial label-then-title pattern matching the palette. */}
        <div className="flex flex-col gap-1 border-b border-border/40 px-6 py-5">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/60">
            Reference
          </span>
          <DialogTitle className="font-heading text-lg leading-tight tracking-tight">
            Keyboard shortcuts
          </DialogTitle>
        </div>

        {/* Scrollable body. */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="flex flex-col gap-7">
            {orderedCategories.map((category) => {
              const rows = grouped.get(category);
              if (!rows || rows.length === 0) return null;
              return (
                <section key={category} className="flex flex-col gap-2.5">
                  <h3 className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/70">
                    {category}
                  </h3>
                  <ul className="flex flex-col">
                    {rows.map((row) => (
                      <li
                        key={row.key}
                        className="flex items-center justify-between gap-4 border-t border-border/30 py-2.5 first:border-t-0"
                      >
                        <span className="text-sm text-foreground/90">
                          {row.title}
                        </span>
                        <ShortcutPieces row={row} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>

        {/* Footer rail — mirrors the palette's bottom hint area. */}
        <div className="flex items-center justify-between border-t border-border/40 px-6 py-3">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/60">
            {totalCount === 0 ? "No shortcuts" : `${totalCount} shortcuts`}
          </span>
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground/70">
            <Kbd>Esc</Kbd>
            <span>to close</span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Renders the right-aligned key combo for a row. Each `piece` becomes its own
 * `Kbd` chip, separated by a hairline `+` (or `…` for the gap before the
 * final piece when the row is the collapsed Go-to-thread range).
 */
function ShortcutPieces({ row }: { row: ShortcutRow }) {
  const isRange = row.key === "thread.goTo.range";
  return (
    <span className="flex items-center gap-1">
      {row.pieces.map((piece, idx) => {
        const isLast = idx === row.pieces.length - 1;
        const separator = isRange && idx === row.pieces.length - 2 ? "\u2026" : "+";
        return (
          <span key={`${piece}-${idx}`} className="flex items-center gap-1">
            <Kbd>{piece}</Kbd>
            {!isLast && (
              <span
                aria-hidden
                className="text-[11px] leading-none text-muted-foreground/40"
              >
                {separator}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
