import type { PanelScope } from "@/lib/panel-tabs";
import type { DiffViewMode } from "@/stores/diffStore";

/**
 * A requirement a Review view depends on beyond its scope. `"git"` views need a
 * git repository (the four working-tree views). Views with no requirement are
 * always offered in their scope.
 */
export type ReviewViewRequirement = "git";

/**
 * The kind of picked operand a comparison view surfaces in the toolbar's
 * contextual operand slot. `"branch"` picks a base→target ref pair; `"commit"`
 * picks a single commit. Views with no operand are *fixed* comparisons
 * (Unstaged, Staged, Last turn, Cumulative) and render no operand control. See
 * CONTEXT.md → "Comparison".
 */
export type ReviewViewOperand = "branch" | "commit";

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
   * Cumulative) describe a thread's turns and are thread-only; the git
   * working-tree views (Unstaged/Staged/Commit/Branch) work in *both* scopes —
   * threadless they read the workspace root, in a thread they read the thread's
   * checkout. So the Review tab is dual-scope and additive: a thread keeps the
   * git views and adds the turn views on top.
   */
  readonly threadOnly: boolean;
  /** Optional extra gate beyond scope; see {@link ReviewViewRequirement}. */
  readonly requires?: ReviewViewRequirement;
  /**
   * The picked operand this view surfaces beside the switcher, if any. Absent
   * for fixed comparisons. The toolbar reserves its operand slot for views that
   * carry one; the picker that fills it lands per-operand in later slices.
   */
  readonly operand?: ReviewViewOperand;
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
  { id: "commit", label: "Commit", threadOnly: false, requires: "git", operand: "commit" },
  { id: "branch", label: "Branch", threadOnly: false, requires: "git", operand: "branch" },
  { id: "last-turn", label: "Last turn", threadOnly: true },
  { id: "cumulative", label: "All turns", threadOnly: true },
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
}

/**
 * The Review views the user can actually pick right now: {@link availableReviewViews}
 * filtered by the runtime gates (git presence for the working-tree views).
 * Pure. Returns catalog order.
 */
export function visibleReviewViews(
  scope: PanelScope,
  gates: ReviewViewGates,
): readonly ReviewView[] {
  return availableReviewViews(scope).filter((view) => {
    if (view.requires === "git" && !gates.isGitRepo) return false;
    return true;
  });
}

/**
 * The thread change-state inputs that pick a thread's default Review view, per
 * ADR-0011. Both are cheap, reactive signals the panel already has: turn changes
 * from the loaded turn snapshots (the same signal the header's changed-file count
 * uses) and working-tree dirtiness from the git status probe.
 */
export interface ReviewChangeState {
  /** The thread has at least one turn snapshot with changed files. */
  readonly hasTurnChanges: boolean;
  /** The thread's working tree has uncommitted changes (manual edits). */
  readonly isDirty: boolean;
}

/**
 * The default Review view for a scope. Threadless has no turns, so it always
 * defaults to the unstaged working-tree diff. A thread picks from its change
 * state (ADR-0011): turn-registered changes -> Last turn; else a dirty working
 * tree -> Unstaged (Branch's committed-only three-dot range would hide manual
 * edits); else the clean tree -> Branch. Passing no change state yields the
 * conservative Branch default for a thread. Used to seed the toolbar and to
 * recover when the active view falls out of scope.
 */
export function defaultReviewView(
  scope: PanelScope,
  changeState?: ReviewChangeState,
): DiffViewMode {
  if (scope === "threadless") return "unstaged";
  if (changeState?.hasTurnChanges) return "last-turn";
  if (changeState?.isDirty) return "unstaged";
  return "branch";
}
