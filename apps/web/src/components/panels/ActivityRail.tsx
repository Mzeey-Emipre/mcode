import { Globe, PanelRight, Plus, X } from "lucide-react";
import type { BrowserTabInfo, BrowserTabSet } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/palette/Kbd";
import { getKeybindingForCommand, formatKeybinding } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import {
  PANEL_TAB_TYPES,
  shownTabTypes,
  creatableTypes,
  type PanelScope,
  type PanelTabType,
} from "@/lib/panel-tabs";
import type { RightPanelTab } from "@/stores/diffStore";
import { cn } from "@/lib/utils";

/** Legacy task completion payload kept for tab API compatibility. */
export interface ScopeProgress {
  readonly done: number;
  readonly total: number;
}

/** Past this many changed files the Review badge renders "{cap}+" instead of the exact count. */
const CHANGES_COUNT_CAP = 99;

/** Catalog metadata (product label + icon) for an openable tab, by store id. */
function metaForTab(id: RightPanelTab): PanelTabType | undefined {
  return PANEL_TAB_TYPES.find((t) => t.id === id);
}

function railDomId(id: RightPanelTab): string {
  return id === "changes" ? "review" : id;
}

/** The mcode keycap for a tab type, or null when it has no binding. */
function tabKeycap(type: PanelTabType): string | null {
  if (!type.commandId) return null;
  const binding = getKeybindingForCommand(type.commandId);
  return binding ? formatKeybinding(binding.key, isMac) : null;
}

/**
 * Accessible name for a rail icon, carrying its glance status as text so screen
 * readers get the signal sighted users read from the count and the freshness
 * color. The visible rail glyph is icon-only, so this is the tab's only name.
 */
function railAccessibleLabel(
  id: RightPanelTab,
  label: string,
  _scope: ScopeProgress,
  changesCount: number,
  changesFresh: boolean,
): string {
  if (id === "tasks") {
    return label;
  }
  if (id === "changes") {
    if (changesCount === 0) return label;
    const files = `${changesCount} ${changesCount === 1 ? "file" : "files"} changed`;
    return `${label}, ${files}${changesFresh ? ", new since last viewed" : ""}`;
  }
  return label;
}

/**
 * Compact glance status under a rail icon: Review
 * file count. Returns null for tabs with nothing to report so a calm icon stays
 * a bare glyph. Mirrors the One Lamp Rule: the active icon tints amber while
 * its status text stays legible.
 */
function RailStatus({
  id,
  active,
  changesCount,
  changesFresh,
}: {
  id: RightPanelTab;
  active: boolean;
  changesCount: number;
  changesFresh: boolean;
}) {
  if (id === "tasks") {
    return null;
  }
  if (id === "changes") {
    if (changesCount === 0) return null;
    const label = changesCount > CHANGES_COUNT_CAP ? `${CHANGES_COUNT_CAP}+` : String(changesCount);
    return (
      <span
        className={cn(
          "font-mono text-[9px] font-medium leading-none tabular-nums",
          changesFresh
            ? "changes-fresh-ring text-primary"
            : active
              ? "text-current"
              : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    );
  }
  return null;
}

/** One rail entry: a select glyph with an active lamp, plus a hover-revealed × to close. */
function RailTab({
  id,
  active,
  scope,
  changesCount,
  changesFresh,
  onSelect,
  onClose,
}: {
  id: RightPanelTab;
  active: boolean;
  scope: ScopeProgress;
  changesCount: number;
  changesFresh: boolean;
  onSelect: (id: RightPanelTab) => void;
  onClose: (id: RightPanelTab) => void;
}) {
  const meta = metaForTab(id);
  if (!meta) return null;
  const Icon = meta.icon;
  const label = meta.label;
  return (
    <div className="group relative">
      <button
        type="button"
        data-rail-tab={railDomId(id)}
        data-active={active ? "true" : undefined}
        aria-pressed={active}
        aria-label={railAccessibleLabel(id, label, scope, changesCount, changesFresh)}
        title={label}
        onClick={() => onSelect(id)}
        className={cn(
          "flex min-h-9 w-9 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 transition-colors",
          active
            ? "bg-card text-primary"
            : "text-foreground/70 hover:bg-card/60 hover:text-foreground",
        )}
      >
        <Icon size={17} />
        <RailStatus
          id={id}
          active={active}
          changesCount={changesCount}
          changesFresh={changesFresh}
        />
      </button>
      {/* Active lamp: a short amber bar on the rail's inner edge. */}
      {active && (
        <span
          data-testid="rail-active-indicator"
          aria-hidden
          className="pointer-events-none absolute -left-1.5 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary"
        />
      )}
      {/* Hover/focus-revealed close. A sibling button (not nested) so the markup
          stays valid and the × is its own focusable, announced control. */}
      <button
        type="button"
        aria-label={`Close ${label}`}
        title={`Close ${label}`}
        onClick={() => onClose(id)}
        className={cn(
          "absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-background text-muted-foreground opacity-0 ring-1 ring-border transition",
          "hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        <X size={10} />
      </button>
    </div>
  );
}

/** Human-readable name for a browser page, used as its rail tooltip / a11y name. */
function pageLabel(page: BrowserTabInfo): string {
  if (page.title && page.title.trim().length > 0) return page.title;
  if (page.url && page.url.trim().length > 0) {
    try {
      const u = new URL(page.url);
      return u.host || u.pathname || page.url;
    } catch {
      return page.url;
    }
  }
  return "New page";
}

/**
 * One browser page in the rail's page switcher: a favicon glyph (globe
 * fallback) with the active-tab lamp when its browser owns the panel, plus a
 * hover-revealed × to close it. Selecting a page focuses the Browser tab and
 * switches the guest to that page.
 */
function BrowserPageRailTab({
  page,
  active,
  browserActive,
  onSelect,
  onClose,
}: {
  page: BrowserTabInfo;
  active: boolean;
  browserActive: boolean;
  onSelect: (pageId: string) => void;
  onClose: (pageId: string) => void;
}) {
  const label = pageLabel(page);
  return (
    <div className="group relative">
      <button
        type="button"
        data-rail-browser-page={page.id}
        data-active={active ? "true" : undefined}
        aria-pressed={active}
        // The live page (active, and Browser owns the panel) is the current
        // page in the switcher; expose that beyond the visual lamp.
        aria-current={active && browserActive ? "page" : undefined}
        aria-label={`Browser page: ${label}`}
        title={label}
        onClick={() => onSelect(page.id)}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
          active && browserActive
            ? "bg-card text-primary"
            : active
              ? "bg-card/60 text-foreground"
              : "text-foreground/70 hover:bg-card/60 hover:text-foreground",
        )}
      >
        {page.faviconUrl ? (
          <img src={page.faviconUrl} alt="" width={17} height={17} className="rounded-[3px]" />
        ) : (
          <Globe size={17} />
        )}
      </button>
      {/* Active lamp mirrors the singleton tabs: a short amber bar on the inner
          edge, shown only when this page is active and Browser owns the panel. */}
      {active && browserActive && (
        <span
          data-testid="rail-active-indicator"
          aria-hidden
          className="pointer-events-none absolute -left-1.5 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary"
        />
      )}
      <button
        type="button"
        aria-label={`Close page ${label}`}
        title={`Close ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose(page.id);
        }}
        className={cn(
          "absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-background text-muted-foreground opacity-0 ring-1 ring-border transition",
          "hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        <X size={10} />
      </button>
    </div>
  );
}

/**
 * The Browser tab's rail presence: its open pages as favicon entries, grouped
 * together so they read as one switcher under the Browser tab. The rail is the
 * page switcher (there is no horizontal strip); the active page's favicon is
 * the Browser glyph, and closing the last page closes the Browser tab.
 */
function BrowserPageGroup({
  tabSet,
  browserActive,
  onSelectPage,
  onClosePage,
}: {
  tabSet: BrowserTabSet;
  browserActive: boolean;
  onSelectPage: (pageId: string) => void;
  onClosePage: (pageId: string) => void;
}) {
  return (
    <div
      data-testid="rail-browser-pages"
      role="group"
      aria-label="Browser pages"
      className="flex flex-col items-center gap-1 rounded-lg bg-foreground/[0.03] py-1"
    >
      {tabSet.tabs.map((page) => (
        <BrowserPageRailTab
          key={page.id}
          page={page}
          active={page.id === tabSet.activeTabId}
          browserActive={browserActive}
          onSelect={onSelectPage}
          onClose={onClosePage}
        />
      ))}
    </div>
  );
}

/**
 * The dynamic add control: hidden when nothing is creatable, opens the one
 * creatable type directly when exactly one remains, otherwise a menu of the
 * shown set (the same set the empty-state grid presents; coming-soon teasers
 * disabled). Only rendered when at least one tab is already open; the empty
 * state's card grid is its own create surface (ADR-0004, issue #611).
 */
function RailAddControl({
  scope,
  openTabs,
  onCreate,
}: {
  scope: PanelScope;
  openTabs: readonly RightPanelTab[];
  onCreate: (id: RightPanelTab) => void;
}) {
  const shown = shownTabTypes(scope, openTabs);
  const creatable = creatableTypes(scope, openTabs);

  // Nothing openable hides the control entirely, even if a coming-soon teaser remains.
  if (creatable.length === 0) return null;

  // Exactly one creatable type opens directly; no pointless menu.
  if (creatable.length === 1) {
    const only = creatable[0];
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground hover:text-foreground"
        title={`New ${only.label}`}
        aria-label={`New ${only.label}`}
        onClick={() => onCreate(only.id as RightPanelTab)}
      >
        <Plus />
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            title="New tab"
            aria-label="New tab"
          >
            <Plus />
          </Button>
        }
      />
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-[184px]">
        {shown.map((type) => {
          const keycap = tabKeycap(type);
          return (
            <DropdownMenuItem
              key={type.id}
              disabled={type.comingSoon}
              onClick={type.comingSoon ? undefined : () => onCreate(type.id as RightPanelTab)}
              className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs"
            >
              <span className="flex items-center gap-2">
                <type.icon size={14} className="text-muted-foreground" />
                {type.label}
              </span>
              {type.comingSoon ? (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                  Soon
                </span>
              ) : (
                keycap && <Kbd>{keycap}</Kbd>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Vertical activity rail for the right panel: panel toggle at the head, then
 * open singleton tabs (active lamp, hover-× close, add control when tabs exist).
 * With no tabs open the rail is only the panel toggle beside the empty-state
 * list. The rail toggle mirrors the chat-header toggle and right-panel shortcut.
 */
export function ActivityRail({
  openTabs,
  activeTab,
  scope,
  scopeProgress,
  changesCount,
  changesFresh,
  browserTabSet,
  onTogglePanel,
  onSelect,
  onClose,
  onCreate,
  onSelectBrowserPage,
  onCloseBrowserPage,
}: {
  readonly openTabs: readonly RightPanelTab[];
  readonly activeTab: RightPanelTab;
  readonly scope: PanelScope;
  readonly scopeProgress: ScopeProgress;
  readonly changesCount: number;
  readonly changesFresh: boolean;
  /** The Browser tab's open pages, or null when none are known (web build / not yet loaded). */
  readonly browserTabSet: BrowserTabSet | null;
  onTogglePanel: () => void;
  onSelect: (id: RightPanelTab) => void;
  onClose: (id: RightPanelTab) => void;
  onCreate: (id: RightPanelTab) => void;
  onSelectBrowserPage: (pageId: string) => void;
  onCloseBrowserPage: (pageId: string) => void;
}) {
  return (
    <div
      data-testid="activity-rail"
      className="flex w-12 flex-none flex-col items-center gap-1 bg-background py-2"
    >
      {/* The panel toggle sits at the rail head (not the foot) so it stays in
          the first tab stop and never scrolls off-screen on short viewports. */}
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onTogglePanel}
        className="shrink-0 text-muted-foreground/70 transition-colors hover:bg-transparent hover:text-foreground"
        aria-label="Toggle panel"
        aria-pressed={true}
        title="Toggle panel"
        data-testid="rail-panel-toggle"
        data-preview-design-keep-open="true"
      >
        <PanelRight />
      </Button>

      {openTabs.map((id) => {
        // The Browser tab becomes its page switcher: when its pages are known,
        // render them as a favicon group instead of the single tab glyph. With
        // none known yet (or a web build with no bridge), fall back to the tab
        // glyph so Browser is still selectable.
        if (id === "preview" && browserTabSet && browserTabSet.tabs.length > 0) {
          return (
            <BrowserPageGroup
              key={id}
              tabSet={browserTabSet}
              browserActive={activeTab === "preview"}
              onSelectPage={onSelectBrowserPage}
              onClosePage={onCloseBrowserPage}
            />
          );
        }
        return (
          <RailTab
            key={id}
            id={id}
            active={id === activeTab}
            scope={scopeProgress}
            changesCount={changesCount}
            changesFresh={changesFresh}
            onSelect={onSelect}
            onClose={onClose}
          />
        );
      })}
      {/* The add control only appears once a tab is open; with none open the
          empty-state card grid is the create surface. */}
      {openTabs.length > 0 && (
        <RailAddControl scope={scope} openTabs={openTabs} onCreate={onCreate} />
      )}
    </div>
  );
}
