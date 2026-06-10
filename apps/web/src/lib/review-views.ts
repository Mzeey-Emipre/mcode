import type { PanelScope } from "@/lib/panel-tabs";
import type { DiffViewMode } from "@/stores/diffStore";

/**
 * A requirement a Review view depends on beyond its scope. `"git"` views need a
 * git repository (the four working-tree views); `"diffSummary"` is gated behind
 * the diff-summary setting. Views with no requirement are always offered in their
 * scope.
 */
export type ReviewViewRequirement = "git" | "diffSummary";

/**
 * Static metadata describing one Review-tab view for the dual-scope selection
 * model. Pure data — no store or React state. See CONTEXT.md → "Review tab".
 */
export interface ReviewView {
  /** Stable id; maps 1:1 onto the store's {@link DiffViewMode}. */
  readonly id: DiffViewMode;
  /** Toolbar label (e.g. "Unstaged", "Last turn"). */
  readonly label: string;
  /**
   * Whether the view requires an active thread. The turn views (Last turn,
   * Cumulative, Summary) describe a thread's turns and are thread-only; the git
   * working-tree views (Unstaged/Staged/Commit/Branch) work in *both* scopes —
   * threadless they read the workspace root, in a thread they read the thread's
   * checkout. So the Review tab is dual-scope and additive: a thread keeps the
   * git views and adds the turn views on top.
   */
  readonly threadOnly: boolean;
  /** Optional extra gate beyond scope; see {@link ReviewViewRequirement}. */
  readonly requires?: ReviewViewRequirement;
}

/**
 * The Review tab's view catalog, in toolbar order. The first four are the git
 * working-tree views (available in both scopes); the last three are the
 * thread-only turn views. Order is the single source of truth for how the
 * toolbar lays out its segmented control, so the helpers preserve it. Each view
 * renders exactly one diff — there is no eager render of every turn.
 */
export const REVIEW_VIEWS: readonly ReviewView[] = [
  { id: "unstaged", label: "Unstaged", threadOnly: false, requires: "git" },
  { id: "staged", label: "Staged", threadOnly: false, requires: "git" },
  { id: "commit", label: "Commit", threadOnly: false, requires: "git" },
  { id: "branch", label: "Branch", threadOnly: false, requires: "git" },
  { id: "last-turn", label: "Last turn", threadOnly: true },
  { id: "cumulative", label: "Cumulative", threadOnly: true },
  { id: "summary", label: "Summary", threadOnly: true, requires: "diffSummary" },
];

/**
 * The Review views available in the given scope, in catalog order. This is the
 * dual-scope selection seam: threadless yields the git working-tree views; a
 * thread yields those same git views plus the turn views (additive). Pure — it
 * ignores runtime gates (git presence, settings); apply those with
 * {@link visibleReviewViews}.
 */
export function availableReviewViews(scope: PanelScope): readonly ReviewView[] {
  return REVIEW_VIEWS.filter((view) => scope === "thread" || !view.threadOnly);
}

/** Runtime conditions that gate views beyond their scope. */
export interface ReviewViewGates {
  /** Whether the active workspace is a git repository (gates the git views). */
  readonly isGitRepo: boolean;
  /** Whether the diff-summary feature is enabled (gates the Summary view). */
  readonly diffSummaryEnabled: boolean;
}

/**
 * The Review views the user can actually pick right now: {@link availableReviewViews}
 * filtered by the runtime gates (git presence for the working-tree views, the
 * diff-summary setting for Summary). Pure. Returns catalog order.
 */
export function visibleReviewViews(
  scope: PanelScope,
  gates: ReviewViewGates,
): readonly ReviewView[] {
  return availableReviewViews(scope).filter((view) => {
    if (view.requires === "git" && !gates.isGitRepo) return false;
    if (view.requires === "diffSummary" && !gates.diffSummaryEnabled) return false;
    return true;
  });
}

/**
 * The default view for a scope: the most recent turn's diff in a thread
 * (`"last-turn"`, the default glance), and the unstaged working-tree diff when
 * threadless. Used to seed the toolbar and to recover when the active view falls
 * out of scope.
 */
export function defaultReviewView(scope: PanelScope): DiffViewMode {
  return scope === "thread" ? "last-turn" : "unstaged";
}
