import type { LucideIcon } from "lucide-react";
import { Globe, Terminal, Files, Diff, ListChecks, Layers, Network, Settings } from "lucide-react";
import type { RightPanelTab } from "@/stores/diffStore";

/**
 * Whether a thread is active. Tab availability is filtered by scope first: some
 * tab types (Plan) only make sense once a thread exists, so they are
 * dropped when the panel runs threadless against the workspace root. See ADR-0004.
 */
export type PanelScope = "threadless" | "thread";

/**
 * Identifier for a creatable panel tab type. Openable types map 1:1 onto the
 * store's {@link RightPanelTab}; `"files"` is a coming-soon teaser that is shown
 * but never actually opened, so it has no backing {@link RightPanelTab}.
 */
export type PanelTabTypeId = RightPanelTab | "files";

/**
 * Static metadata describing one panel tab type for the availability model and
 * the empty-state card grid. Pure data — no store or React state.
 */
export interface PanelTabType {
  /** Stable id; openable ids are {@link RightPanelTab}, `"files"` is coming-soon only. */
  readonly id: PanelTabTypeId;
  /** Product-facing name shown on the card (e.g. "Browser", "Review"). */
  readonly label: string;
  /** Card glyph. */
  readonly icon: LucideIcon;
  /** One-line description shown under the label on the empty-state card. */
  readonly blurb: string;
  /** Only creatable once a thread exists; dropped by the scope filter when threadless. */
  readonly needsThread: boolean;
  /** Shown as a disabled teaser and excluded from the creatable set (Files). */
  readonly comingSoon?: boolean;
  /** Opened only by a product workflow and therefore omitted from creation surfaces. */
  readonly systemManaged?: boolean;
  /**
   * Command id whose keybinding renders as the card's keycap. Absent for
   * coming-soon types, which have no binding yet.
   */
  readonly commandId?: string;
}

/**
 * The revamp's tab-type catalog, in display order (ADR-0004). Order is the
 * single source of truth for how cards and rail entries are laid out, so the
 * availability helpers preserve it. Labels are the product language (Browser,
 * Review, Plan) even though the openable ids reuse the legacy
 * {@link RightPanelTab} values (preview, changes, tasks).
 */
export const PANEL_TAB_TYPES: readonly PanelTabType[] = [
  {
    id: "preview",
    label: "Browser",
    icon: Globe,
    blurb: "Open a website",
    needsThread: false,
    commandId: "preview.toggle",
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: Terminal,
    blurb: "Start a shell",
    needsThread: false,
    commandId: "terminal.toggle",
  },
  {
    id: "action-terminal",
    label: "Project Action",
    icon: Terminal,
    blurb: "View Action output",
    needsThread: true,
    systemManaged: true,
  },
  {
    id: "files",
    label: "Files",
    icon: Files,
    blurb: "Browse project files",
    needsThread: false,
    comingSoon: true,
  },
  {
    id: "changes",
    label: "Review",
    icon: Diff,
    blurb: "View code changes",
    // Dual-scope: the git working-tree views (Unstaged/Staged/Commit/Branch)
    // read the workspace root and need no thread; a thread adds the turn views.
    // See CONTEXT.md → "Review tab".
    needsThread: false,
    commandId: "changes.toggle",
  },
  {
    id: "environment",
    label: "Project settings",
    icon: Settings,
    blurb: "Edit Project environment",
    needsThread: false,
    commandId: "projectEnvironment.open",
  },
  {
    id: "tasks",
    label: "Plan",
    icon: ListChecks,
    blurb: "Read saved plans",
    needsThread: true,
    commandId: "tasks.toggle",
  },
  {
    id: "subagents",
    label: "Subagents",
    icon: Layers,
    blurb: "Follow delegated work",
    needsThread: true,
  },
  {
    id: "coordination",
    label: "Coordination",
    icon: Network,
    blurb: "Coordinate across Projects",
    needsThread: true,
  },
];

/**
 * Tab types displayed in the current scope, in catalog order: scope-filtered
 * (thread-only types dropped when threadless) then cardinality-filtered
 * (singletons already open dropped). Terminal remains repeatable. Coming-soon teasers (Files) are kept so the
 * empty-state grid can render them disabled. Pure — does not read or mutate any
 * external state.
 */
export function shownTabTypes(
  scope: PanelScope,
  openTabs: readonly PanelTabTypeId[],
): readonly PanelTabType[] {
  return PANEL_TAB_TYPES.filter((type) => {
    const allowedInScope = scope === "thread" || !type.needsThread;
    return !type.systemManaged && allowedInScope && (type.id === "terminal" || !openTabs.includes(type.id));
  });
}

/**
 * The creatable tab types in the current scope: {@link shownTabTypes} minus the
 * coming-soon teasers. This is the set the user can actually open, used for the
 * creatable count and (in the rail) the add control. Pure.
 */
export function creatableTypes(
  scope: PanelScope,
  openTabs: readonly PanelTabTypeId[],
): readonly PanelTabType[] {
  return shownTabTypes(scope, openTabs).filter((type) => !type.comingSoon);
}
