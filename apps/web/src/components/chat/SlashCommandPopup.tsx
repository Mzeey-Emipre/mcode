import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { Terminal, Zap, Puzzle, Sparkles, RefreshCw } from "lucide-react";
import { NAMESPACE_BADGE_STYLES } from "@/lib/slash-command-styles";
import type { Command, PopupState } from "./useSlashCommand";
import { computeFixedPopupPosition } from "./popup-position";

const ITEM_HEIGHT = 44; // px per row
const VISIBLE_ITEMS = 8;
const STATUS_ROW_HEIGHT = ITEM_HEIGHT;
// Footer (Refresh row) intrinsic height: border-t (1px) + py-1 (8px) + icon
// button height (~20px). Used to estimate popup height for the above/below
// placement calculation; the rendered footer remains naturally sized.
const FOOTER_HEIGHT = 28;

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

  // Cap the scrollable list at VISIBLE_ITEMS rows; shorter lists size to
  // their natural content so a popup with two items isn't truncated.
  const listMaxHeight = VISIBLE_ITEMS * ITEM_HEIGHT;

  // Estimate the rendered popup height for the above/below placement
  // decision. Only the list branch renders a footer (Refresh row); error,
  // inline-loading, and empty branches do not. Including FOOTER_HEIGHT in
  // those cases would cause unnecessary above-placement flips.
  const willRenderList = state.kind === "ready" || state.kind === "staleRevalidating";
  const estimatedHeight =
    (willRenderList
      ? Math.min(items.length, VISIBLE_ITEMS) * ITEM_HEIGHT
      : STATUS_ROW_HEIGHT) +
    (willRenderList ? FOOTER_HEIGHT : 0);
  const style = computeFixedPopupPosition({
    anchorRect,
    estimatedHeight,
    minWidth: 320,
  });

  const popup = (
    // role="listbox" is intentionally NOT on this outer wrapper: the
    // Refresh footer button and the ErrorRow's Retry button live inside
    // and would be invalid descendants of a listbox per WAI-ARIA. The
    // role is moved down to the options container only.
    <div
      data-slash-popup
      style={style}
      className={cn(
        "z-50 flex flex-col overflow-hidden rounded-lg border shadow-lg",
        "animate-in fade-in-0 zoom-in-95 duration-[120ms]",
        tone === "dark"
          ? "border-white/10 bg-[#1e1e1e] text-neutral-100"
          : "border-border bg-card",
        className,
      )}
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
                  className="min-h-0 flex-1"
                  style={{ maxHeight: listMaxHeight, overflowY: "auto" }}
                >
                  {items.map((cmd, i) => (
                    <div key={cmd.name} role="presentation" data-index={i}>
                      <CommandRow
                        cmd={cmd}
                        selected={i === selectedIndex}
                        onSelect={onSelect}
                        tone={tone}
                      />
                    </div>
                  ))}
                </div>
                <div className={cn(
                  "flex shrink-0 items-center justify-end border-t px-2 py-1",
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
                      "rounded p-1",
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
    </div>
  );
  return createPortal(popup, document.body);
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
        "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
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
        "flex h-5 w-5 flex-shrink-0 items-center justify-center",
        tone === "dark" ? "text-neutral-400" : "text-muted-foreground",
      )}>
        {cmd.namespace === "mcode" ? (
          <Zap size={12} />
        ) : cmd.namespace === "plugin" ? (
          <Puzzle size={12} />
        ) : cmd.namespace === "skill" ? (
          <Sparkles size={12} />
        ) : (
          <Terminal size={12} />
        )}
      </span>

      {/* Name + description */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn(
          "truncate text-sm font-medium",
          tone === "dark" ? "text-neutral-50" : "text-foreground",
        )}>
          /{cmd.name}
        </span>
        <span className={cn(
          "truncate text-xs",
          tone === "dark" ? "text-neutral-400" : "text-muted-foreground",
        )}>
          {cmd.description}
        </span>
      </span>

      {/* Namespace badge */}
      <span
        className={cn(
          "ml-auto flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
          NAMESPACE_BADGE_STYLES[cmd.namespace],
        )}
      >
        {cmd.namespace}
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
