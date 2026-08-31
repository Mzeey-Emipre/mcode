import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Globe,
  Maximize2,
  Minimize2,
  MousePointer2,
  PanelRight,
  Plus,
  X,
} from "lucide-react";
import type { BrowserTabInfo, BrowserTabSet } from "@mcode/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import type { RightPanelTab, RightPanelTabInstance } from "@/stores/diffStore";
import {
  isBrowserAutomationAgentControlled,
  useBrowserAutomationStore,
} from "@/features/preview";
import { cn } from "@/lib/utils";

/** Legacy task completion payload kept for tab API compatibility. */
export interface ScopeProgress {
  readonly done: number;
  readonly total: number;
}

/** Past this many changed files the Review badge renders "{cap}+" instead of the exact count. */
const CHANGES_COUNT_CAP = 99;

/** Hover-intent delay before the rail reveals labels. */
const RAIL_EXPAND_DELAY_MS = 140;

/** Grace period that keeps the rail open while the pointer moves between rows. */
const RAIL_COLLAPSE_DELAY_MS = 250;

/** Width that the expanded rail floats over Browser content beyond its collapsed footprint. */
export const ACTIVITY_RAIL_FLOATING_OVERLAP_PX = 112;

/** Shared trailing anchor for expanded-rail actions. */
const RAIL_TRAILING_CONTROL_CLASS = "absolute right-0 top-0";

function RailTooltip({
  content,
  disabled = false,
  children,
}: {
  content: string;
  disabled?: boolean;
  children: ReactElement;
}) {
  return (
    <Tooltip disabled={disabled}>
      <TooltipTrigger render={children} />
      <TooltipContent side="right">{content}</TooltipContent>
    </Tooltip>
  );
}

function getPointerReorderDirection(
  item: HTMLDivElement,
  pointerY: number,
): -1 | 1 | null {
  const siblings = Array.from(
    item.parentElement?.querySelectorAll<HTMLElement>(":scope > [data-rail-instance]") ?? [],
  );
  const index = siblings.indexOf(item);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  return previous && pointerY <= previous.getBoundingClientRect().bottom
    ? -1
    : next && pointerY >= next.getBoundingClientRect().top
      ? 1
      : null;
}

/** Pointer and keyboard reorder boundary for one top-level rail instance. */
function ReorderableRailItem({
  instanceId,
  children,
  onReorder,
}: {
  instanceId: string;
  children: ReactNode;
  onReorder: (instanceId: string, direction: -1 | 1) => void;
}) {
  const draggingRef = useRef(false);
  const dragStartYRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-rail-close]")) return;
    suppressClickRef.current = false;
    draggingRef.current = true;
    dragStartYRef.current = event.clientY;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const dragStartY = dragStartYRef.current;
    if (dragStartY === null || Math.abs(event.clientY - dragStartY) < 4) return;
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const direction = getPointerReorderDirection(event.currentTarget, event.clientY);
    if (direction === null) return;
    onReorder(instanceId, direction);
    suppressClickRef.current = true;
  };

  const onPointerUp = () => {
    draggingRef.current = false;
    dragStartYRef.current = null;
  };

  const onPointerCancel = () => {
    draggingRef.current = false;
    dragStartYRef.current = null;
    suppressClickRef.current = false;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!event.altKey || !event.shiftKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    event.stopPropagation();
    onReorder(instanceId, event.key === "ArrowUp" ? -1 : 1);
  };

  return (
    <div
      data-rail-instance={instanceId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {children}
    </div>
  );
}

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
  expanded,
  changesCount,
  changesFresh,
}: {
  id: RightPanelTab;
  active: boolean;
  expanded: boolean;
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
          "font-mono text-xs font-medium leading-none tabular-nums transition-[opacity,transform] motion-reduce:duration-0 motion-reduce:transition-none",
          expanded
            ? "absolute right-2 top-1/2 -translate-y-1/2 group-hover:opacity-0"
            : "mt-0.5",
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
  label: labelOverride,
  active,
  expanded,
  scope,
  changesCount,
  changesFresh,
  onSelect,
  onClose,
}: {
  id: RightPanelTab;
  label?: string;
  active: boolean;
  expanded: boolean;
  scope: ScopeProgress;
  changesCount: number;
  changesFresh: boolean;
  onSelect: (id: RightPanelTab) => void;
  onClose: (id: RightPanelTab) => void;
}) {
  const presentation = getRailTabPresentation(id, labelOverride);
  if (!presentation) return null;
  const { Icon, label } = presentation;
  return (
    <div className="group relative w-full">
      <RailTooltip content={label} disabled={expanded}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-rail-tab={railDomId(id)}
          data-active={active ? "true" : undefined}
          aria-pressed={active}
          aria-label={railAccessibleLabel(id, label, scope, changesCount, changesFresh)}
          onClick={() => onSelect(id)}
          className={cn(
            "relative h-8 w-full overflow-hidden px-2 text-xs transition-colors",
            expanded ? "flex-row justify-start gap-2" : "flex-col gap-0",
            active
              ? "bg-card text-primary"
              : "text-foreground/70 hover:bg-card/60 hover:text-foreground",
          )}
        >
          <Icon size={17} />
          <span
            aria-hidden
            className={cn(
              "absolute left-8 right-8 truncate text-left font-medium text-foreground transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
              expanded ? "translate-x-0 opacity-100" : "translate-x-1 opacity-0",
            )}
          >
            {label}
          </span>
          <RailStatus
            id={id}
            active={active}
            expanded={expanded}
            changesCount={changesCount}
            changesFresh={changesFresh}
          />
        </Button>
      </RailTooltip>
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
      <RailTooltip content={`Close ${label}`} disabled={expanded}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Close ${label}`}
          data-rail-close
          onClick={() => onClose(id)}
          className={cn(
            RAIL_TRAILING_CONTROL_CLASS,
            "text-muted-foreground opacity-0 transition-opacity motion-reduce:duration-0 motion-reduce:transition-none hover:bg-card hover:text-foreground",
            expanded
              ? "focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
              : "pointer-events-none",
          )}
        >
          <X size={12} />
        </Button>
      </RailTooltip>
    </div>
  );
}

function getRailTabPresentation(id: RightPanelTab, labelOverride: string | undefined) {
  const meta = metaForTab(id);
  if (!meta) return null;
  return { Icon: meta.icon, label: labelOverride ?? meta.label };
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
  workspaceId,
  active,
  browserActive,
  expanded,
  onSelect,
  onClose,
}: {
  page: BrowserTabInfo;
  workspaceId: string;
  active: boolean;
  browserActive: boolean;
  expanded: boolean;
  onSelect: (pageId: string) => void;
  onClose: (pageId: string) => void;
}) {
  const label = pageLabel(page);
  const agentControlled = useBrowserAutomationStore(
    (state) => isBrowserAutomationAgentControlled(state, workspaceId, page.threadId, page.id),
  );
  const activePage = active && browserActive;
  return (
    <div className="group relative w-full">
      <RailTooltip content={label} disabled={expanded}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-rail-browser-page={page.id}
          data-active={active ? "true" : undefined}
          aria-pressed={active}
          // The live page (active, and Browser owns the panel) is the current
          // page in the switcher; expose that beyond the visual lamp.
          aria-current={activePage ? "page" : undefined}
          aria-label={`Browser page: ${label}${agentControlled ? ", agent controls Browser" : ""}`}
          onClick={() => onSelect(page.id)}
          className={cn(
            "relative h-8 w-full justify-start overflow-hidden px-2 text-xs transition-colors",
            browserPageRailClass(active, browserActive),
          )}
        >
          <BrowserPageRailGlyph agentControlled={agentControlled} faviconUrl={page.faviconUrl} />
          <span
            aria-hidden
            className={cn(
              "absolute left-8 right-8 truncate text-left font-medium text-foreground transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
              expanded ? "translate-x-0 opacity-100" : "translate-x-1 opacity-0",
            )}
          >
            {label}
          </span>
        </Button>
      </RailTooltip>
      {/* Active lamp mirrors the singleton tabs: a short amber bar on the inner
          edge, shown only when this page is active and Browser owns the panel. */}
      {activePage && (
        <span
          data-testid="rail-active-indicator"
          aria-hidden
          className="pointer-events-none absolute -left-1.5 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary"
        />
      )}
      <RailTooltip content={`Close ${label}`} disabled={expanded}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Close page ${label}`}
          data-rail-close
          onClick={(e) => {
            e.stopPropagation();
            onClose(page.id);
          }}
          className={cn(
            RAIL_TRAILING_CONTROL_CLASS,
            "text-muted-foreground opacity-0 transition-opacity motion-reduce:duration-0 motion-reduce:transition-none hover:bg-card hover:text-foreground",
            expanded
              ? "focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
              : "pointer-events-none",
          )}
        >
          <X size={12} />
        </Button>
      </RailTooltip>
    </div>
  );
}

function browserPageRailClass(active: boolean, browserActive: boolean): string {
  if (active && browserActive) return "bg-card text-primary";
  if (active) return "bg-card/60 text-foreground";
  return "text-foreground/70 hover:bg-card/60 hover:text-foreground";
}

function BrowserPageRailGlyph({
  agentControlled,
  faviconUrl,
}: {
  agentControlled: boolean;
  faviconUrl: string | null;
}) {
  if (agentControlled) {
    return (
      <MousePointer2
        data-testid="browser-agent-control-indicator"
        size={17}
        className="text-amber-500"
        aria-hidden
      />
    );
  }
  if (faviconUrl) {
    return <img src={faviconUrl} alt="" width={17} height={17} className="rounded-[3px]" />;
  }
  return <Globe size={17} />;
}

/**
 * The Browser tab's rail presence: its open pages as favicon entries, grouped
 * together so they read as one switcher under the Browser tab. The rail is the
 * page switcher (there is no horizontal strip); the active page's favicon is
 * the Browser glyph, and closing the last page closes the Browser tab.
 */
function BrowserPageGroup({
  tabSet,
  workspaceId,
  browserActive,
  expanded,
  onSelectPage,
  onClosePage,
}: {
  tabSet: BrowserTabSet;
  workspaceId: string;
  browserActive: boolean;
  expanded: boolean;
  onSelectPage: (pageId: string) => void;
  onClosePage: (pageId: string) => void;
}) {
  return (
    <div
      data-testid="rail-browser-pages"
      role="group"
      aria-label="Browser pages"
      className="flex w-full flex-col items-stretch gap-0.5 rounded-lg bg-foreground/[0.03] py-0.5"
    >
      {tabSet.tabs.map((page) => (
        <BrowserPageRailTab
          key={page.id}
          page={page}
          workspaceId={workspaceId}
          active={page.id === tabSet.activeTabId}
          browserActive={browserActive}
          expanded={expanded}
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
  expanded,
  onCreate,
  terminalCapReached,
}: {
  scope: PanelScope;
  openTabs: readonly RightPanelTab[];
  expanded: boolean;
  onCreate: (id: RightPanelTab) => void;
  readonly terminalCapReached?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const shown = shownTabTypes(scope, openTabs);
  const creatable = creatableTypes(scope, openTabs).filter(
    (type) => !(terminalCapReached && type.id === "terminal"),
  );

  // Nothing openable hides the control entirely, even if a coming-soon teaser remains.
  if (creatable.length === 0) return null;

  // Exactly one creatable type opens directly; no pointless menu.
  if (creatable.length === 1) {
    const only = creatable[0];
    return (
      <RailTooltip content={`New ${only.label}`} disabled={expanded}>
        <Button
          variant="ghost"
          size="sm"
          className="relative h-8 w-full justify-start overflow-hidden px-2 text-muted-foreground hover:text-foreground"
          aria-label={`New ${only.label}`}
          onClick={() => onCreate(only.id as RightPanelTab)}
        >
          <Plus />
          <span
            aria-hidden
            className={cn(
              "absolute left-8 right-2 truncate text-left text-xs font-medium transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
              expanded ? "translate-x-0 opacity-100" : "translate-x-1 opacity-0",
            )}
          >
            New {only.label}
          </span>
        </Button>
      </RailTooltip>
    );
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <RailTooltip content="New tab" disabled={expanded}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="relative h-8 w-full justify-start overflow-hidden px-2 text-muted-foreground hover:text-foreground"
              aria-label="New tab"
            >
              <Plus />
              <span
                aria-hidden
                className={cn(
                  "absolute left-8 right-2 truncate text-left text-xs font-medium transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
                  expanded ? "translate-x-0 opacity-100" : "translate-x-1 opacity-0",
                )}
              >
                New tab
              </span>
            </Button>
          }
        />
      </RailTooltip>
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-[184px]">
        {shown.map((type) => {
          const keycap = tabKeycap(type);
          return (
            <DropdownMenuItem
              key={type.id}
            disabled={type.comingSoon || (terminalCapReached && type.id === "terminal")}
            onClick={type.comingSoon || (terminalCapReached && type.id === "terminal")
              ? undefined
              : () => onCreate(type.id as RightPanelTab)}
              className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs"
            >
              <span className="flex items-center gap-2">
                <type.icon size={14} className="text-muted-foreground" />
                {type.label}
              </span>
              {type.comingSoon ? (
                <Badge variant="secondary" size="sm" className="uppercase tracking-wide">
                  Soon
                </Badge>
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

interface ActivityRailProps {
  readonly workspaceId: string;
  readonly tabInstances: readonly RightPanelTabInstance[];
  readonly activeTabId: string | null;
  readonly scope: PanelScope;
  readonly scopeProgress: ScopeProgress;
  readonly changesCount: number;
  readonly changesFresh: boolean;
  /** The Browser tab's open pages, or null when none are known (web build / not yet loaded). */
  readonly browserTabSet: BrowserTabSet | null;
  /** Whether the panel fills the content area beside the project tree. */
  readonly maximized: boolean;
  onTogglePanel: () => void;
  onToggleMaximized: () => void;
  onSelect: (instanceId: string) => void;
  onClose: (instanceId: string) => void;
  onReorder: (instanceId: string, direction: -1 | 1) => void;
  onCreate: (id: RightPanelTab) => void;
  /** Whether this scope already owns its four allowed shell sessions. */
  readonly terminalCapReached?: boolean;
  /** PTY-backed rail labels keyed by terminal tab identity. */
  readonly terminalLabels?: Readonly<Record<string, string>>;
  onSelectBrowserPage: (instanceId: string, pageId: string) => void;
  onCloseBrowserPage: (pageId: string) => void;
  /** Publishes the floating state so Browser surfaces exclude the covered edge. */
  readonly onExpandedChange?: (expanded: boolean) => void;
}

interface ActivityRailViewProps extends ActivityRailProps {
  readonly railRef: React.RefObject<HTMLDivElement | null>;
  readonly expanded: boolean;
  onPointerEnter: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onFocusCapture: () => void;
  onBlurCapture: (event: ReactFocusEvent<HTMLDivElement>) => void;
}

function RailHeader({
  expanded,
  maximized,
  onTogglePanel,
  onToggleMaximized,
}: Pick<ActivityRailViewProps, "expanded" | "maximized" | "onTogglePanel" | "onToggleMaximized">) {
  return (
    <div className="relative h-8 w-full shrink-0">
      <RailTooltip content="Close panel" disabled={expanded}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onTogglePanel}
          className="relative h-8 w-full justify-start overflow-hidden px-2 text-muted-foreground/70 transition-colors hover:bg-transparent hover:text-foreground"
          aria-label="Close panel"
          data-testid="rail-panel-toggle"
          data-preview-design-keep-open="true"
        >
          <PanelRight />
          <span
            aria-hidden
            className={cn(
              "absolute left-8 right-8 truncate text-left text-xs font-medium transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
              expanded ? "translate-x-0 opacity-100" : "translate-x-1 opacity-0",
            )}
          >
            Close panel
          </span>
        </Button>
      </RailTooltip>
      <RailTooltip content={maximized ? "Restore panel" : "Maximize panel"}>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onToggleMaximized}
          className={cn(
            RAIL_TRAILING_CONTROL_CLASS,
            "text-muted-foreground/70 transition-[color,opacity] motion-reduce:duration-0 motion-reduce:transition-none hover:bg-card hover:text-foreground",
            expanded ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          aria-label={maximized ? "Restore panel" : "Maximize panel"}
          data-testid="rail-maximize-toggle"
          data-preview-design-keep-open="true"
        >
          {maximized ? <Minimize2 /> : <Maximize2 />}
        </Button>
      </RailTooltip>
    </div>
  );
}

function RailTabInstances({
  workspaceId,
  tabInstances,
  activeTabId,
  scopeProgress,
  changesCount,
  changesFresh,
  browserTabSet,
  expanded,
  onSelect,
  onClose,
  onReorder,
  terminalLabels,
  onSelectBrowserPage,
  onCloseBrowserPage,
}: Pick<
  ActivityRailViewProps,
  | "workspaceId"
  | "tabInstances"
  | "activeTabId"
  | "scopeProgress"
  | "changesCount"
  | "changesFresh"
  | "browserTabSet"
  | "expanded"
  | "onSelect"
  | "onClose"
  | "onReorder"
  | "terminalLabels"
  | "onSelectBrowserPage"
  | "onCloseBrowserPage"
>) {
  return tabInstances.map((instance) => {
    const { id: instanceId, type: id } = instance;
    // The Browser tab becomes its page switcher: when its pages are known,
    // render them as a favicon group instead of the single tab glyph. With
    // none known yet (or a web build with no bridge), fall back to the tab
    // glyph so Browser is still selectable.
    if (id === "preview" && browserTabSet && browserTabSet.tabs.length > 0) {
      return (
        <ReorderableRailItem key={instanceId} instanceId={instanceId} onReorder={onReorder}>
          <BrowserPageGroup
            tabSet={browserTabSet}
            workspaceId={workspaceId}
            browserActive={activeTabId === instanceId}
            expanded={expanded}
            onSelectPage={(pageId) => onSelectBrowserPage(instanceId, pageId)}
            onClosePage={onCloseBrowserPage}
          />
        </ReorderableRailItem>
      );
    }
    return (
      <ReorderableRailItem key={instanceId} instanceId={instanceId} onReorder={onReorder}>
        <RailTab
          id={id}
          label={
            id === "terminal" || id === "action-terminal"
              ? terminalLabels?.[instanceId] ?? (id === "terminal" ? "Terminal" : "Project Action")
              : undefined
          }
          active={instanceId === activeTabId}
          expanded={expanded}
          scope={scopeProgress}
          changesCount={changesCount}
          changesFresh={changesFresh}
          onSelect={() => onSelect(instanceId)}
          onClose={() => onClose(instanceId)}
        />
      </ReorderableRailItem>
    );
  });
}

function RailFooter({
  scope,
  tabInstances,
  expanded,
  onCreate,
  terminalCapReached,
}: Pick<ActivityRailViewProps, "scope" | "tabInstances" | "expanded" | "onCreate" | "terminalCapReached">) {
  const openTabs = tabInstances.map((instance) => instance.type);
  return (
    <>
      {/* The add control only appears once a tab is open; with none open the
          empty-state card grid is the create surface. */}
      {openTabs.length > 0 && (
        <RailAddControl
          scope={scope}
          openTabs={openTabs}
          expanded={expanded}
          onCreate={onCreate}
          terminalCapReached={terminalCapReached}
        />
      )}
      {terminalCapReached && (
        <span className="sr-only" role="status">
          Maximum of 4 terminals reached for this scope.
        </span>
      )}
    </>
  );
}

function ActivityRailView({
  workspaceId,
  tabInstances,
  activeTabId,
  scope,
  scopeProgress,
  changesCount,
  changesFresh,
  browserTabSet,
  maximized,
  onTogglePanel,
  onToggleMaximized,
  onSelect,
  onClose,
  onReorder,
  onCreate,
  terminalCapReached,
  terminalLabels,
  onSelectBrowserPage,
  onCloseBrowserPage,
  railRef,
  expanded,
  onPointerEnter,
  onPointerLeave,
  onFocusCapture,
  onBlurCapture,
}: ActivityRailViewProps) {
  return (
    <div
      ref={railRef}
      data-testid="activity-rail"
      data-expanded={expanded ? "true" : "false"}
      className={cn(
        "relative z-30 flex-none bg-background transition-[width,margin-right] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0 motion-reduce:transition-none",
        expanded ? "w-40 -mr-28" : "w-12",
      )}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-0 flex w-full flex-col items-stretch gap-0.5 overflow-hidden bg-background px-1.5 py-2",
          expanded && "border-r border-border/50",
        )}
      >
      {/* Panel-level actions stay at the rail head so they remain the first tab
          stops and never scroll off-screen on short viewports. */}
      <RailHeader
        expanded={expanded}
        maximized={maximized}
        onTogglePanel={onTogglePanel}
        onToggleMaximized={onToggleMaximized}
      />
      <RailTabInstances
        workspaceId={workspaceId}
        tabInstances={tabInstances}
        activeTabId={activeTabId}
        scopeProgress={scopeProgress}
        changesCount={changesCount}
        changesFresh={changesFresh}
        browserTabSet={browserTabSet}
        expanded={expanded}
        onSelect={onSelect}
        onClose={onClose}
        onReorder={onReorder}
        terminalLabels={terminalLabels}
        onSelectBrowserPage={onSelectBrowserPage}
        onCloseBrowserPage={onCloseBrowserPage}
      />
      <RailFooter
        scope={scope}
        tabInstances={tabInstances}
        expanded={expanded}
        onCreate={onCreate}
        terminalCapReached={terminalCapReached}
      />
      </div>
    </div>
  );
}

/**
 * Vertical activity rail for the right panel: close and maximize controls at the head, then
 * open singleton tabs (active lamp, hover-× close, add control when tabs exist).
 * With no tabs open the rail keeps only the panel actions beside the empty-state
 * list. The close action mirrors the chat-header toggle and right-panel shortcut.
 */
export function ActivityRail({
  workspaceId,
  tabInstances,
  activeTabId,
  scope,
  scopeProgress,
  changesCount,
  changesFresh,
  browserTabSet,
  maximized,
  onTogglePanel,
  onToggleMaximized,
  onSelect,
  onClose,
  onReorder,
  onCreate,
  terminalCapReached,
  terminalLabels,
  onSelectBrowserPage,
  onCloseBrowserPage,
  onExpandedChange,
}: ActivityRailProps) {
  const [expanded, setExpanded] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerWithinRef = useRef(false);
  const focusWithinRef = useRef(false);

  const clearExpandTimer = useCallback(() => {
    if (expandTimerRef.current === null) return;
    clearTimeout(expandTimerRef.current);
    expandTimerRef.current = null;
  }, []);

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimerRef.current === null) return;
    clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = null;
  }, []);

  const scheduleExpand = useCallback(() => {
    clearCollapseTimer();
    if (expanded || expandTimerRef.current !== null) return;
    expandTimerRef.current = setTimeout(() => {
      expandTimerRef.current = null;
      if (pointerWithinRef.current) setExpanded(true);
    }, RAIL_EXPAND_DELAY_MS);
  }, [clearCollapseTimer, expanded]);

  const scheduleCollapse = useCallback(() => {
    clearExpandTimer();
    clearCollapseTimer();
    collapseTimerRef.current = setTimeout(() => {
      collapseTimerRef.current = null;
      const focusWithin = railRef.current?.contains(document.activeElement) ?? false;
      focusWithinRef.current = focusWithin;
      if (!pointerWithinRef.current && !focusWithin) setExpanded(false);
    }, RAIL_COLLAPSE_DELAY_MS);
  }, [clearCollapseTimer, clearExpandTimer]);

  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  useEffect(
    () => () => {
      clearExpandTimer();
      clearCollapseTimer();
    },
    [clearCollapseTimer, clearExpandTimer],
  );

  const onPointerEnter = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    pointerWithinRef.current = true;
    scheduleExpand();
  };

  const onPointerLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    pointerWithinRef.current = false;
    scheduleCollapse();
  };

  const onFocusCapture = () => {
    focusWithinRef.current = true;
    clearExpandTimer();
    clearCollapseTimer();
    setExpanded(true);
  };

  const onBlurCapture = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    focusWithinRef.current = false;
    scheduleCollapse();
  };

  return (
    <ActivityRailView
      workspaceId={workspaceId}
      tabInstances={tabInstances}
      activeTabId={activeTabId}
      scope={scope}
      scopeProgress={scopeProgress}
      changesCount={changesCount}
      changesFresh={changesFresh}
      browserTabSet={browserTabSet}
      maximized={maximized}
      onTogglePanel={onTogglePanel}
      onToggleMaximized={onToggleMaximized}
      onSelect={onSelect}
      onClose={onClose}
      onReorder={onReorder}
      onCreate={onCreate}
      terminalCapReached={terminalCapReached}
      terminalLabels={terminalLabels}
      onSelectBrowserPage={onSelectBrowserPage}
      onCloseBrowserPage={onCloseBrowserPage}
      railRef={railRef}
      expanded={expanded}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    />
  );
}
