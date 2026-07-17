import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Command, PopupState } from "./useSlashCommand";
import { ComposerOverlaySurface } from "./ComposerOverlaySurface";
import { EntityIcon } from "./EntityToken";
import { Button } from "@/components/ui/button";

const ITEM_HEIGHT = 44; // px per row
const VISIBLE_ITEMS = 8;
const GROUP_HEADER_HEIGHT = 28;
const STATUS_ROW_HEIGHT = ITEM_HEIGHT;
const LIST_SURFACE_PADDING = 8;
const LIST_BOTTOM_FADE_HEIGHT = 20;

const NAMESPACE_LABELS: Record<Command["namespace"], string> = {
  mcode: "Mcode",
  command: "Commands",
  skill: "Skills",
  plugin: "Plugins",
};

function commandDisplayLabel(command: Command): string {
  if (command.namespace === "skill") return command.name;
  if (command.namespace === "plugin") return command.name.split(":").at(-1) ?? command.name;
  return `/${command.name}`;
}

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
    Math.min(commandGroups.length, VISIBLE_ITEMS) * GROUP_HEADER_HEIGHT +
    LIST_BOTTOM_FADE_HEIGHT;

  // Estimate the rendered popup height before positioning. The scrollport is
  // inset from the surface so its native scrollbar clears the rounded corner.
  const willRenderList = state.kind === "ready" || state.kind === "staleRevalidating";
  const renderedListHeight = Math.min(
    items.length * ITEM_HEIGHT + commandGroups.length * GROUP_HEADER_HEIGHT + LIST_BOTTOM_FADE_HEIGHT,
    listMaxHeight,
  );
  const estimatedHeight =
    willRenderList ? renderedListHeight + LIST_SURFACE_PADDING : STATUS_ROW_HEIGHT;
  const popup = (
    // The listbox role belongs to the scrolling options container. The error
    // branch renders its Retry control outside that semantic container.
    <ComposerOverlaySurface
      data-slash-popup
      anchorRect={anchorRect}
      estimatedHeight={estimatedHeight}
      attached
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
                <div className="relative p-1">
                  <div
                    ref={scrollRef}
                    role="listbox"
                    aria-label="Slash commands"
                    aria-activedescendant={items[selectedIndex] ? `slash-cmd-${items[selectedIndex].name}` : undefined}
                    className="overflow-y-auto"
                    style={{ maxHeight: listMaxHeight, scrollbarGutter: "stable" }}
                  >
                    <div className="pb-5">
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
                              "bg-popover px-2 py-1.5 text-xs font-medium text-foreground",
                              tone === "dark" && "bg-[#1e1e1e] text-neutral-100",
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
                  </div>
                  <div
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-x-1 bottom-1 h-5 bg-gradient-to-t from-popover via-popover/90 to-transparent",
                      tone === "dark" && "from-[#1e1e1e] via-[#1e1e1e]/90",
                    )}
                  />
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
    <Button
      type="button"
      variant="ghost"
      size="sm"
      id={`slash-cmd-${cmd.name}`}
      role="option"
      aria-selected={selected}
      onMouseDown={(e) => {
        e.preventDefault(); // prevent textarea blur
        onSelect(cmd);
      }}
      className={cn(
        "h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
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
        "flex size-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset",
        tone === "dark"
          ? "bg-white/[0.06] text-neutral-400 ring-white/10"
          : "bg-muted/65 text-muted-foreground ring-border/60",
      )}>
        <EntityIcon kind={cmd.namespace} size={14} className="flex items-center justify-center" />
      </span>

      {/* Name + description */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn(
          "truncate text-sm font-medium leading-4",
          tone === "dark" ? "text-neutral-50" : "text-foreground",
        )}>
          {commandDisplayLabel(cmd)}
        </span>
        <span className={cn(
          "overflow-hidden whitespace-nowrap text-xs font-normal leading-4",
          tone === "dark" ? "text-neutral-400" : "text-muted-foreground",
        )} style={{
          maskImage: "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
        }}>
          {cmd.description}
        </span>
      </span>
    </Button>
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
      <Button
        type="button"
        variant="ghost"
        size="sm"
        // Same pattern as the footer Refresh button: preventDefault on
        // mousedown to retain editor focus, action on click for keyboard a11y.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRetry}
        className={cn(
          "h-6 rounded-md px-2 text-xs",
          tone === "dark"
            ? "text-neutral-100 hover:bg-white/10"
            : "text-foreground hover:bg-accent",
        )}
      >
        Retry
      </Button>
    </div>
  );
}
