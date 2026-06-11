import { getKeybindingForCommand, formatKeybinding } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import { Kbd } from "@/components/palette/Kbd";
import {
  shownTabTypes,
  type PanelScope,
  type PanelTabType,
  type PanelTabTypeId,
} from "@/lib/panel-tabs";
import type { RightPanelTab } from "@/stores/diffStore";
import { cn } from "@/lib/utils";

/** The mcode keycap for a tab type, or null when it has no binding. */
function tabKeycap(type: PanelTabType): string | null {
  if (!type.commandId) return null;
  const binding = getKeybindingForCommand(type.commandId);
  return binding ? formatKeybinding(binding.key, isMac) : null;
}

/** "Soon" tag for tab types that are not openable yet (deferred features). */
function SoonBadge() {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
      Soon
    </span>
  );
}

/**
 * The empty-state create surface for the right panel: a centered list of the
 * tab types creatable in the current scope, under a short header. Each row
 * carries an icon, label, blurb, and the type's mcode keycap; clicking one opens
 * that tab. Coming-soon types (Files) render as a disabled "Soon" teaser and are
 * excluded from the creatable set. There is intentionally no add control here —
 * the list is the create surface (ADR-0004, issue #610).
 *
 * A single column (rather than a grid) keeps the surface legible at the panel's
 * minimum width, gives the first-listed types (Browser, Terminal) natural
 * primacy, and never orphans an odd card on a half-empty row.
 */
export function PanelEmptyState({
  scope,
  openTabs,
  onOpen,
}: {
  scope: PanelScope;
  /** Tab types already open, dropped from the list by the cardinality filter. */
  readonly openTabs: readonly PanelTabTypeId[];
  /** Open (create-or-focus) a tab type. Never called for coming-soon teasers. */
  onOpen: (id: RightPanelTab) => void;
}) {
  const rows = shownTabTypes(scope, openTabs);

  return (
    <div
      data-testid="panel-empty-state"
      className="flex h-full flex-col overflow-y-auto px-5 py-10"
    >
      {/* m-auto centers the block when there's room and lets it scroll from the
          top when the list is taller than the panel (auto margins collapse
          rather than clip, unlike justify-center). */}
      <div className="m-auto w-full max-w-sm">
        <header className="mb-5 text-center">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            Open a tool
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Pick one to open it in this panel.
          </p>
        </header>
        <div className="flex flex-col gap-1.5">
          {rows.map((type) => {
            const Icon = type.icon;
            const keycap = tabKeycap(type);
            return (
              <button
                key={type.id}
                type="button"
                data-testid={`panel-card-${type.id}`}
                disabled={type.comingSoon}
                aria-label={type.comingSoon ? `${type.label} (coming soon)` : `Open ${type.label}`}
                onClick={type.comingSoon ? undefined : () => onOpen(type.id as RightPanelTab)}
                className={cn(
                  "flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-3 text-left transition-colors",
                  type.comingSoon
                    ? "cursor-default opacity-50"
                    : "hover:border-primary/50 hover:bg-card/80",
                )}
              >
                <span className="grid size-9 flex-none place-items-center rounded-md bg-muted/40 text-muted-foreground">
                  <Icon size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{type.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{type.blurb}</span>
                </span>
                {type.comingSoon ? <SoonBadge /> : keycap && <Kbd>{keycap}</Kbd>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
