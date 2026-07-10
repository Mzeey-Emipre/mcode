import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Terminal, Zap, Puzzle, Sparkles, RefreshCw } from "lucide-react";
import type { Command, PopupState } from "./useSlashCommand";
import { ComposerOverlaySurface } from "./ComposerOverlaySurface";

const ITEM_HEIGHT = 44; // px per row
const VISIBLE_ITEMS = 8;
const GROUP_HEADER_HEIGHT = 24;
const STATUS_ROW_HEIGHT = ITEM_HEIGHT;
// Placement is calculated before layout, so account for the list padding and borders here.
const LIST_SURFACE_CHROME = 12;
// Footer (Refresh row) intrinsic height: border-t (1px) + py-1 (8px) + icon
// button height (~20px). Used to estimate popup height for the above/below
// placement calculation; the rendered footer remains naturally sized.
const FOOTER_HEIGHT = 28;

const NAMESPACE_LABELS: Record<Command["namespace"], string> = {
  mcode: "Mcode",
  command: "Commands",
  skill: "Skills",
  plugin: "Plugins",
};

/** Preserve command ordering while exposing the source context of each command. */
function groupCommands(
  items: Command[],
): Array<{ namespace: Command["namespace"]; items: Array<{ command: Command; index: number }> }> {
  const groups: Array<{
    namespace: Command["namespace"];
    items: Array<{ command: Command; index: number }>;
  }> = [];
  for (const [index, command] of items.entries()) {
    const current = groups.at(-1);
    if (current?.namespace === command.namespace) {
      current.items.push({ command, index });
      continue;
    }
    groups.push({ namespace: command.namespace, items: [{ command, index }] });
  }
  return groups;
}

/** Props for the {@link SlashCommandPopup} component. */
interface SlashCommandPopupProps {
  /** Typed render state from {@link useSlashCommand}; the popup switches on `state.kind`. */
  state: PopupState;
  selectedIndex: number;
  anchorRect: DOMRect | null;
  onSelect: (cmd: Command) => void;
  onDismiss: () => void;
  onRetry: () => void;
  /**
   * `"dark"` switches every surface, text, hover, and border token to dark
   * hardcoded values so the popup coheres with the annotation bubble's
   * intentionally dark palette (which must stay readable over arbitrary user
   * web content regardless of the app theme). `"default"` (the default) leaves
   * the Tailwind theme tokens untouched so the Composer's rendering is
   * byte-identical to before this prop was added.
   */
  tone?: "default" | "dark";
  /** Extra class names for border/positioning overrides that don't belong in tone. */
  className?: string;
}

/**
 * Floating popup that lists slash command suggestions anchored to the
 * composer editor. Handles keyboard navigation via `selectedIndex`, caps the
 * visible list height, flips above/below the anchor based on available viewport
 * space, and dismisses on outside click. The render priority (error → list →
 * inline loader → empty) is encoded by the {@link PopupState} union rather than
 * a comment, so this component is an exhaustive switch on `state.kind`.
 */
export function SlashCommandPopup({
  state,
  selectedIndex,
  anchorRect,
  onSelect,
  onDismiss,
  onRetry,
  tone = "default",
  className,
}: SlashCommandPopupProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // The list-bearing states carry the items; all others render no list.
  const items: Command[] =
    state.kind === "ready" || state.kind === "staleRevalidating" ? state.items : [];
  const commandGroups = groupCommands(items);
  const isOpen = state.kind !== "closed";

  // Scroll selected item into view
  useEffect(() => {
    if (!isOpen) return;
    const el = scrollRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, isOpen, items.length]);

  // Dismiss on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-slash-popup]")) {
        onDismiss();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onDismiss]);

  if (state.kind === "closed" || !anchorRect) return null;

  const listMaxHeight =
    VISIBLE_ITEMS * ITEM_HEIGHT +
    Math.min(commandGroups.length, VISIBLE_ITEMS) * GROUP_HEADER_HEIGHT;

  // Estimate the rendered popup height for the above/below placement
  // decision. Only the list branch renders a footer (Refresh row); error,
  // inline-loading, and empty branches do not. Including FOOTER_HEIGHT in
  // those cases would cause unnecessary above-placement flips.
  const willRenderList = state.kind === "ready" || state.kind === "staleRevalidating";
  const estimatedHeight =
    (willRenderList
      ? Math.min(
          items.length * ITEM_HEIGHT + commandGroups.length * GROUP_HEADER_HEIGHT,
          listMaxHeight,
        )
      : STATUS_ROW_HEIGHT) +
    (willRenderList ? FOOTER_HEIGHT + LIST_SURFACE_CHROME : 0);
  const popup = (
    // role="listbox" is intentionally NOT on this outer wrapper: the
    // Refresh footer button and the ErrorRow's Retry button live inside
    // and would be invalid descendants of a listbox per WAI-ARIA. The
    // role is moved down to the options container only.
    <ComposerOverlaySurface
      data-slash-popup
      anchorRect={anchorRect}
      estimatedHeight={estimatedHeight}
      tone={tone}
      className={className}
    >
      {/*
        Render priority (stale-while-revalidate) is encoded by PopupState:
          - error             -> ErrorRow (surfaces transient failures even
                                 when built-in commands are present)
          - ready             -> list (settled, not revalidating)
          - staleRevalidating -> list (cached items shown while a fresh load
                                 is in flight; identical render, but a named
                                 state so the stuck-popup case is testable)
          - loading           -> inline "Loading commands..." (no cached items
                                 yet, e.g. a filter excludes every built-in)
          - empty             -> EmptyState (no matches, not loading, no error)
        `closed` is handled by the early return above, so this switch over the
        remaining kinds is exhaustive and compiler-checked.
      */}
      {(() => {
        switch (state.kind) {
          case "error":
            return <ErrorRow message={state.error.message} onRetry={onRetry} tone={tone} />;
          case "ready":
          case "staleRevalidating":
            return (
              <>
                <div
                  ref={scrollRef}
                  role="listbox"
                  aria-label="Slash commands"
                  aria-activedescendant={items[selectedIndex] ? `slash-cmd-${items[selectedIndex].name}` : undefined}
                  className="min-h-0 flex-1 p-1"
                  style={{ maxHeight: listMaxHeight, overflowY: "auto" }}
                >
                  {commandGroups.map(({ namespace, items: groupItems }) => (
                    <div
                      key={namespace}
                      role="group"
                      aria-label={NAMESPACE_LABELS[namespace]}
                      data-testid={`slash-command-group-${namespace}`}
                    >
                      <div
                        data-slash-group-heading
                        role="presentation"
                        className={cn(
                          "sticky top-0 z-10 bg-inherit px-2 py-1.5 text-xs font-medium",
                          tone === "dark" ? "text-neutral-400" : "text-muted-foreground",
                        )}
                      >
                        {NAMESPACE_LABELS[namespace]}
                      </div>
                      {groupItems.map(({ command: cmd, index }) => {
                        return (
                          <div key={cmd.name} role="presentation" data-index={index}>
                            <CommandRow
                              cmd={cmd}
                              selected={index === selectedIndex}
                              onSelect={onSelect}
                              tone={tone}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
                <div className={cn(
                  "flex shrink-0 items-center justify-end border-t p-1",
                  tone === "dark" ? "border-white/[0.08]" : "border-border",
                )}>
                  <button
                    type="button"
                    aria-label="Refresh commands"
                    // onMouseDown preventDefault keeps editor focus on pointer use;
                    // onClick fires on both pointer and keyboard activation (Enter/Space).
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={onRetry}
                    className={cn(
                      "size-8 rounded-md",
                      tone === "dark"
                        ? "text-neutral-400 hover:bg-white/10 hover:text-neutral-100"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <RefreshCw size={12} />
                  </button>
                </div>
              </>
            );
          case "loading":
            return <LoadingInline tone={tone} />;
          case "empty":
            return <EmptyState tone={tone} />;
        }
      })()}
    </ComposerOverlaySurface>
  );
  return popup;
}

function CommandRow({
  cmd,
  selected,
  onSelect,
  tone = "default",
}: {
  cmd: Command;
  selected: boolean;
  onSelect: (cmd: Command) => void;
  tone?: "default" | "dark";
}) {
  return (
    <button
      type="button"
      id={`slash-cmd-${cmd.name}`}
      role="option"
      aria-selected={selected}
      onMouseDown={(e) => {
        e.preventDefault(); // prevent textarea blur
        onSelect(cmd);
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
        tone === "dark"
          ? selected
            ? "bg-white/[0.12]"
            : "hover:bg-white/[0.06]"
          : selected
            ? "bg-accent"
            : "hover:bg-accent/50",
      )}
    >
      {/* Icon column */}
      <span className={cn(
        "flex size-4 shrink-0 items-center justify-center",
        tone === "dark" ? "text-neutral-400" : "text-muted-foreground",
      )}>
        {cmd.namespace === "mcode" ? (
          <Zap size={13} />
        ) : cmd.namespace === "plugin" ? (
          <Puzzle size={13} />
        ) : cmd.namespace === "skill" ? (
          <Sparkles size={13} />
        ) : (
          <Terminal size={13} />
        )}
      </span>

      {/* Name + description */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn(
          "truncate text-[13px] font-medium leading-4",
          tone === "dark" ? "text-neutral-50" : "text-foreground",
        )}>
          /{cmd.name}
        </span>
        <span className={cn(
          "truncate text-[11px] leading-4",
          tone === "dark" ? "text-neutral-400" : "text-muted-foreground",
        )}>
          {cmd.description}
        </span>
      </span>
    </button>
  );
}

/**
 * Single-row "Loading commands..." indicator. Replaces the previous 3-row
 * skeleton-shimmer block. The skeleton was visually noisy and triggered on
 * every cold start, workspace switch, and cache-invalidation push; with the
 * stale-while-revalidate render order in this component plus the eager
 * prefetch in `useSlashCommand`, this branch should only be reachable when
 * the user has typed a filter that excludes every cached built-in AND a
 * skill load is still in flight -- an exceedingly rare combination.
 */
function LoadingInline({ tone = "default" }: { tone?: "default" | "dark" }) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      role="status"
      className="flex items-center gap-3 px-3 py-2"
    >
      <span className="flex h-5 w-5 flex-shrink-0" />
      <span className={cn(
        "text-sm",
        tone === "dark" ? "text-neutral-400" : "text-muted-foreground",
      )}>Loading commands...</span>
    </div>
  );
}

function EmptyState({ tone = "default" }: { tone?: "default" | "dark" }) {
  return (
    <div aria-live="polite" role="status" className="flex items-center gap-3 px-3 py-2">
      <span className="flex h-5 w-5 flex-shrink-0" />
      <span className={cn(
        "text-sm",
        tone === "dark" ? "text-neutral-400" : "text-muted-foreground",
      )}>No commands match</span>
    </div>
  );
}

function ErrorRow({
  message,
  onRetry,
  tone = "default",
}: {
  message: string;
  onRetry: () => void;
  tone?: "default" | "dark";
}) {
  return (
    <div role="alert" className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
      <span className="flex-1 truncate">Couldn't load commands: {message}</span>
      <button
        type="button"
        // Same pattern as the footer Refresh button: preventDefault on
        // mousedown to retain editor focus, action on click for keyboard a11y.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRetry}
        className={cn(
          "rounded px-2 py-0.5",
          tone === "dark"
            ? "text-neutral-100 hover:bg-white/10"
            : "text-foreground hover:bg-accent",
        )}
      >
        Retry
      </button>
    </div>
  );
}
