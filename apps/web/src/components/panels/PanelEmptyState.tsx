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
 * The empty-state create surface for the right panel: a card grid of the tab
 * types creatable in the current scope. Each card carries an icon, label, blurb,
 * and the type's mcode keycap; clicking one opens that tab. Coming-soon types
 * (Files) render as a disabled "Soon" teaser and are excluded from the creatable
 * set. There is intentionally no add control here — the grid is the create
 * surface (ADR-0004, issue #610).
 */
export function PanelEmptyState({
  scope,
  openTabs,
  onOpen,
}: {
  scope: PanelScope;
  /** Tab types already open, dropped from the grid by the cardinality filter. */
  readonly openTabs: readonly PanelTabTypeId[];
  /** Open (create-or-focus) a tab type. Never called for coming-soon teasers. */
  onOpen: (id: RightPanelTab) => void;
}) {
  const cards = shownTabTypes(scope, openTabs);

  return (
    <div
      data-testid="panel-empty-state"
      className="flex h-full flex-col overflow-y-auto p-6"
    >
      <div className="m-auto grid w-full max-w-md grid-cols-2 gap-3">
        {cards.map((type) => {
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
                "flex flex-col items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-center transition-colors",
                type.comingSoon
                  ? "cursor-default opacity-50"
                  : "hover:border-primary/50 hover:bg-card/80",
              )}
            >
              <Icon size={22} className="text-muted-foreground" />
              <div className="text-sm font-medium text-foreground">{type.label}</div>
              <div className="text-xs text-muted-foreground">{type.blurb}</div>
              {type.comingSoon ? <SoonBadge /> : keycap && <Kbd>{keycap}</Kbd>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
