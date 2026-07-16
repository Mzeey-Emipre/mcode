import type { PullRequestDetail } from "@mcode/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PullRequestDetailToolbar } from "../PullRequestDetailToolbar";

function detail(
  url = "https://github.com/Mzeey-Empire/mcode/pull/42",
): PullRequestDetail {
  return {
    identity: {
      provider: "github",
      repositoryNodeId: "repo-node",
      owner: "Mzeey-Empire",
      repository: "mcode",
      number: 42,
    },
    providerNodeId: "pull-request-node",
    url,
    title: "Keep pull request state legible",
    body: "",
    author: null,
    state: "open",
    readiness: "ready",
    head: {
      owner: "contributor",
      repository: "mcode",
      name: "feature/detail",
      oid: "a".repeat(40),
    },
    base: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: "main",
      oid: "b".repeat(40),
    },
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-11T12:00:00.000Z",
    mergeability: "mergeable",
    mergeMethods: ["merge"],
    defaultMergeMethod: "merge",
    reviewDecision: "review_required",
    reviewers: [],
    checks: { state: "passing" },
    checkCount: 1,
    commentCount: 0,
    reviewThreadCount: 0,
  };
}

function renderToolbar(
  model: PullRequestDetail,
  props: { isNarrow?: boolean; onBack?: () => void; onClose?: () => void } = {},
) {
  return render(
    <TooltipProvider>
      <PullRequestDetailToolbar
        model={model}
        tabs={<div role="tablist" aria-label="Pull request detail views" />}
        {...props}
      />
    </TooltipProvider>,
  );
}

describe("PullRequestDetailToolbar", () => {
  it("keeps navigation and icon-only browser actions in the top toolbar", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderToolbar(detail(), { onClose });

    expect(
      screen.getByRole("tablist", { name: "Pull request detail views" }),
    ).toBeVisible();
    const browserAction = screen.getByRole("link", { name: "Open in browser" });
    expect(browserAction).toHaveAttribute(
      "href",
      "https://github.com/Mzeey-Empire/mcode/pull/42",
    );
    expect(browserAction).not.toHaveTextContent("Open in browser");
    await user.click(
      screen.getByRole("button", { name: "Close pull request detail" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses a back action in the narrow toolbar", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    renderToolbar(detail(), { isNarrow: true, onBack });

    await user.click(
      screen.getByRole("button", { name: "Back to pull requests" }),
    );
    expect(onBack).toHaveBeenCalledOnce();
    expect(screen.queryByText("Mzeey-Empire/mcode")).not.toBeInTheDocument();
    expect(screen.queryByText("#42")).not.toBeInTheDocument();
  });

  it("keeps the refresh spinner aligned inside the actions menu", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <PullRequestDetailToolbar
          model={detail()}
          detail={detail()}
          tabs={<div />}
          capabilities={null}
          onRefresh={vi.fn()}
          refreshing
        />
      </TooltipProvider>,
    );

    const actions = screen.getByRole("button", {
      name: "Pull request actions",
    });
    actions.focus();
    await user.keyboard("{Enter}");
    expect(
      (await screen.findByRole("menuitem", { name: "Refresh" })).querySelector(
        "span",
      ),
    ).toHaveStyle({ "--spinner-size": "13px" });
  });

  it.each([
    "https://user:secret@github.com/Mzeey-Empire/mcode/pull/42",
    "javascript:alert(1)",
    "/Mzeey-Empire/mcode/pull/42",
  ])("omits the browser action for unsafe URL %s", (url) => {
    renderToolbar(detail(url));
    expect(
      screen.queryByRole("link", { name: "Open in browser" }),
    ).not.toBeInTheDocument();
  });
});
