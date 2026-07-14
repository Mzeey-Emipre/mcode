import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDiffInlineRow } from "@/lib/pull-request-diff-row-model";
import { usePullRequestReviewDraftStore } from "@/stores/pullRequestReviewDraftStore";
import { PullRequestInlineThread } from "../PullRequestInlineThread";

vi.mock("../RemoteMarkdown", () => ({
  RemoteMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

const row: PullRequestDiffInlineRow = {
  kind: "inline",
  key: "inline-1",
  snapshotKey: "snapshot-a",
  path: "src/a.ts",
  coordinate: null,
  placement: "outdated",
  anchorLineKey: "line-8",
  threads: [
    {
      kind: "review_thread",
      providerNodeId: "thread-1",
      path: "src/a.ts",
      line: 8,
      startLine: 8,
      side: "right",
      startSide: "right",
      originalLine: 7,
      originalStartLine: 7,
      subjectType: "line",
      commitOid: "a".repeat(40),
      headOid: "b".repeat(40),
      isResolved: false,
      isOutdated: true,
      createdAt: "2026-07-11T10:00:00.000Z",
      updatedAt: "2026-07-11T10:00:00.000Z",
      totalCount: 1,
      comments: [
        {
          providerNodeId: "comment-1",
          author: null,
          body: "Remote body",
          createdAt: "2026-07-11T10:00:00.000Z",
          updatedAt: "2026-07-11T10:00:00.000Z",
          url: "https://github.com/owner/repo/pull/1#discussion_r1",
        },
      ],
    },
  ],
  drafts: [
    {
      localId: "draft-1",
      path: "src/a.ts",
      coordinate: null,
      outdated: true,
    },
  ],
};

describe("PullRequestInlineThread", () => {
  beforeEach(() => {
    usePullRequestReviewDraftStore.setState({
      drafts: {
        "draft-1": {
          localId: "draft-1",
          snapshotKey: "snapshot-a",
          identityKey: "identity-a",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
          kind: "inline",
          path: "src/a.ts",
          coordinate: null,
          threadProviderNodeId: null,
          body: "Draft body",
          bodyBytes: 10,
          createdAt: 1,
          updatedAt: 1,
          outdated: true,
        },
      },
      order: ["draft-1"],
      totalBodyBytes: 10,
    });
  });

  it("renders remote comments as inert content and labels outdated state", () => {
    render(
      <PullRequestInlineThread
        row={row}
        onUpdateDraft={() => true}
        onRemoveDraft={vi.fn()}
        onRestoreFocus={vi.fn()}
      />,
    );

    expect(screen.getByText("Remote body")).toBeVisible();
    expect(screen.getAllByText("Outdated")).toHaveLength(2);
    expect(
      screen.queryByRole("link", { name: "Open comment" }),
    ).not.toBeInTheDocument();
  });

  it("updates drafts and restores the originating line after discard", async () => {
    const user = userEvent.setup();
    const update = vi.fn(() => true);
    const remove = vi.fn();
    const restore = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    render(
      <PullRequestInlineThread
        row={row}
        onUpdateDraft={update}
        onRemoveDraft={remove}
        onRestoreFocus={restore}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Review draft" });
    fireEvent.change(editor, { target: { value: "Revised" } });
    expect(update).toHaveBeenLastCalledWith("draft-1", "Revised");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(remove).toHaveBeenCalledWith("draft-1");
    expect(restore).toHaveBeenCalledWith("line-8");
  });
});
