import { describe, it, expect } from "vitest";
import {
  REVIEW_VIEWS,
  availableReviewViews,
  visibleReviewViews,
  defaultReviewView,
  type ReviewView,
} from "../review-views";

/** Pull just the ids out of a result for terse assertions. */
function ids(views: readonly ReviewView[]): string[] {
  return views.map((v) => v.id);
}

describe("REVIEW_VIEWS catalog", () => {
  it("lists the git working-tree views then the turn views, in toolbar order", () => {
    expect(ids(REVIEW_VIEWS)).toEqual([
      "unstaged",
      "staged",
      "commit",
      "branch",
      "last-turn",
      "cumulative",
      "summary",
    ]);
  });

  it("marks the git working-tree views as available in any scope and the turn views as thread-only", () => {
    const anyScope = REVIEW_VIEWS.filter((v) => !v.threadOnly).map((v) => v.id);
    const threadOnly = REVIEW_VIEWS.filter((v) => v.threadOnly).map((v) => v.id);
    expect(anyScope).toEqual(["unstaged", "staged", "commit", "branch"]);
    expect(threadOnly).toEqual(["last-turn", "cumulative", "summary"]);
  });

  it("marks every git view as git-requiring and Summary as summary-gated", () => {
    expect(REVIEW_VIEWS.filter((v) => v.requires === "git").map((v) => v.id)).toEqual([
      "unstaged",
      "staged",
      "commit",
      "branch",
    ]);
    expect(REVIEW_VIEWS.filter((v) => v.requires === "diffSummary").map((v) => v.id)).toEqual([
      "summary",
    ]);
  });

  it("carries a picked operand only on the comparison views (Branch, Commit)", () => {
    expect(REVIEW_VIEWS.filter((v) => v.operand).map((v) => [v.id, v.operand])).toEqual([
      ["commit", "commit"],
      ["branch", "branch"],
    ]);
    // The fixed-operand views surface no operand control.
    const fixed = REVIEW_VIEWS.filter((v) => !v.operand).map((v) => v.id);
    expect(fixed).toEqual(["unstaged", "staged", "last-turn", "cumulative", "summary"]);
  });
});

describe("availableReviewViews — dual-scope selection", () => {
  it("yields just the git working-tree views when threadless", () => {
    expect(ids(availableReviewViews("threadless"))).toEqual([
      "unstaged",
      "staged",
      "commit",
      "branch",
    ]);
  });

  it("yields the git views plus the turn views in a thread (additive)", () => {
    expect(ids(availableReviewViews("thread"))).toEqual([
      "unstaged",
      "staged",
      "commit",
      "branch",
      "last-turn",
      "cumulative",
      "summary",
    ]);
  });

  it("keeps every threadless view available in a thread too", () => {
    const threadless = ids(availableReviewViews("threadless"));
    const thread = ids(availableReviewViews("thread"));
    expect(threadless.every((id) => thread.includes(id))).toBe(true);
  });
});

describe("visibleReviewViews — runtime gates", () => {
  it("drops all threadless views in a non-git workspace", () => {
    expect(
      ids(visibleReviewViews("threadless", { isGitRepo: false, diffSummaryEnabled: false })),
    ).toEqual([]);
  });

  it("keeps the git views in a git workspace", () => {
    expect(
      ids(visibleReviewViews("threadless", { isGitRepo: true, diffSummaryEnabled: false })),
    ).toEqual(["unstaged", "staged", "commit", "branch"]);
  });

  it("drops Summary in a thread when the diff-summary setting is off", () => {
    expect(
      ids(visibleReviewViews("thread", { isGitRepo: true, diffSummaryEnabled: false })),
    ).toEqual(["unstaged", "staged", "commit", "branch", "last-turn", "cumulative"]);
  });

  it("keeps Summary in a thread when the diff-summary setting is on", () => {
    expect(
      ids(visibleReviewViews("thread", { isGitRepo: true, diffSummaryEnabled: true })),
    ).toEqual([
      "unstaged",
      "staged",
      "commit",
      "branch",
      "last-turn",
      "cumulative",
      "summary",
    ]);
  });

  it("leaves the turn views unaffected by git presence (only git views drop)", () => {
    expect(
      ids(visibleReviewViews("thread", { isGitRepo: false, diffSummaryEnabled: true })),
    ).toEqual(["last-turn", "cumulative", "summary"]);
  });
});

describe("defaultReviewView", () => {
  it("defaults a thread to the last-turn diff", () => {
    expect(defaultReviewView("thread")).toBe("last-turn");
  });

  it("defaults threadless to the unstaged working-tree diff", () => {
    expect(defaultReviewView("threadless")).toBe("unstaged");
  });
});

describe("availableReviewViews / visibleReviewViews — purity and order", () => {
  it("returns results in catalog order regardless of scope", () => {
    expect(ids(availableReviewViews("threadless"))).toEqual(
      REVIEW_VIEWS.filter((v) => !v.threadOnly).map((v) => v.id),
    );
  });

  it("does not mutate the catalog", () => {
    const before = ids(REVIEW_VIEWS);
    visibleReviewViews("thread", { isGitRepo: true, diffSummaryEnabled: true });
    availableReviewViews("threadless");
    expect(ids(REVIEW_VIEWS)).toEqual(before);
  });
});
