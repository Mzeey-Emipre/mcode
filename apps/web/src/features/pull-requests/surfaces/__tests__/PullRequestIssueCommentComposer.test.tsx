import type {
  PullRequestIdentity,
  PullRequestMutationExpected,
  PullRequestPostCommentResult,
} from "@mcode/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPullRequestMutationLaneKey,
  usePullRequestMutationStore,
  type PullRequestMutationLane,
} from "@/features/pull-requests/state/pullRequestMutationStore";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import type { PullRequestTransport } from "@/transport/pull-requests";
import { PullRequestIssueCommentComposer } from "../PullRequestIssueCommentComposer";

const identity: PullRequestIdentity = {
  provider: "github",
  repositoryNodeId: "R_repo",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 42,
};
const expected: PullRequestMutationExpected = {
  providerNodeId: "PR_42",
  state: "open",
  readiness: "ready",
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};

function readTransport(): PullRequestTransport {
  return {
    getCapabilities: vi.fn().mockResolvedValue({ ok: false }),
    list: vi.fn().mockResolvedValue({ ok: false }),
    get: vi.fn().mockResolvedValue({ ok: false }),
    timeline: vi.fn().mockResolvedValue({ ok: false }),
    files: vi.fn().mockResolvedValue({ ok: false }),
    patch: vi.fn().mockResolvedValue({ ok: false }),
    cancel: vi.fn().mockResolvedValue({ ok: true, cancelled: false }),
  };
}

function transport(postComment: PullRequestMutationTransport["postComment"]): PullRequestMutationTransport {
  const unavailable = vi.fn().mockResolvedValue({ ok: false, error: { code: "remote_unavailable", message: "offline" } });
  return {
    postComment,
    submitReview: unavailable,
    setReadiness: unavailable,
    close: unavailable,
    merge: unavailable,
  };
}

describe("PullRequestIssueCommentComposer", () => {
  beforeEach(() => {
    usePullRequestMutationStore.setState({ lanes: {}, commentDrafts: {} });
  });

  it("does not write while drafting and exposes busy state after explicit Post comment", async () => {
    const user = userEvent.setup();
    let resolve!: (result: PullRequestPostCommentResult) => void;
    const postComment = vi.fn().mockImplementation(
      () => new Promise<PullRequestPostCommentResult>((done) => { resolve = done; }),
    );
    render(
      <PullRequestIssueCommentComposer
        identity={identity}
        expected={expected}
        capability={{ allowed: true }}
        mutationTransport={transport(postComment)}
        readTransport={readTransport()}
      />,
    );

    const textarea = screen.getByRole("textbox", { name: /Comment for Mzeey-Empire\/mcode #42/ });
    await user.type(textarea, "Check the retry boundary.");
    expect(postComment).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Post comment" }));
    expect(postComment).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "Add a comment" })).toHaveAttribute("aria-busy", "true");
    const request = postComment.mock.calls[0]![0];
    expect(request).toMatchObject({ identity, expected, body: "Check the retry boundary." });
    expect(request.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);

    resolve({
      ok: true,
      effect: "comment",
      idempotencyKey: request.idempotencyKey,
      comment: {
        providerNodeId: "COMMENT_1",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-1",
        createdAt: "2026-07-12T01:00:00.000Z",
      },
    });
    expect(await screen.findByText("Comment posted.")).toBeVisible();
    expect(textarea).toHaveValue("");
  });

  it("keeps the empty Timeline composer compact", () => {
    render(
      <PullRequestIssueCommentComposer
        identity={identity}
        expected={expected}
        capability={{ allowed: true }}
        mutationTransport={transport(vi.fn())}
        readTransport={readTransport()}
      />,
    );

    const textarea = screen.getByRole("textbox", {
      name: /Comment for Mzeey-Empire\/mcode #42/,
    });
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea).toHaveAttribute("rows", "1");
    expect(textarea).toHaveClass(
      "min-h-12",
      "max-h-32",
      "field-sizing-content",
      "resize-none",
      "border-0",
      "bg-transparent",
      "pr-12",
    );
    expect(textarea).not.toHaveClass("resize-y", "field-sizing-fixed");
    expect(
      screen.getByRole("button", { name: "Post comment" }),
    ).toHaveClass("absolute", "bottom-2", "right-2", "rounded-full");
    expect(
      screen.getByRole("region", { name: "Add a comment" }),
    ).toHaveClass(
      "relative",
      "z-10",
      "before:bg-gradient-to-t",
      "before:from-page",
      "before:to-transparent",
    );
    expect(
      screen.getByRole("region", { name: "Add a comment" }),
    ).not.toHaveClass("border-t", "bg-page");
    expect(screen.queryByText("Ctrl/⌘ Enter to post")).not.toBeInTheDocument();
    expect(screen.getByText("0 / 65,536 bytes")).toHaveClass("sr-only");
  });

  it("uses Mod+Enter as an explicit keyboard path", async () => {
    const user = userEvent.setup();
    const postComment = vi.fn().mockImplementation(async (request) => ({
      ok: true,
      effect: "comment",
      idempotencyKey: request.idempotencyKey,
      comment: {
        providerNodeId: "COMMENT_1",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-1",
        createdAt: "2026-07-12T01:00:00.000Z",
      },
    }));
    render(
      <PullRequestIssueCommentComposer
        identity={identity}
        expected={expected}
        capability={{ allowed: true }}
        mutationTransport={transport(postComment)}
        readTransport={readTransport()}
      />,
    );
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "Keyboard comment");
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(postComment).toHaveBeenCalledOnce();
  });

  it("posts a compact reply and closes it after acceptance", async () => {
    const user = userEvent.setup();
    const onPosted = vi.fn();
    const postComment = vi.fn().mockImplementation(async (request) => ({
      ok: true,
      effect: "comment",
      idempotencyKey: request.idempotencyKey,
      comment: {
        providerNodeId: "COMMENT_REPLY",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-2",
        createdAt: "2026-07-12T01:05:00.000Z",
      },
    }));
    usePullRequestMutationStore
      .getState()
      .setCommentDraft(identity, "@reviewer Addressed in the latest change.");

    render(
      <PullRequestIssueCommentComposer
        identity={identity}
        expected={expected}
        capability={{ allowed: true }}
        mutationTransport={transport(postComment)}
        readTransport={readTransport()}
        variant="reply"
        replyTo="reviewer"
        onPosted={onPosted}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Post reply" }));
    expect(postComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "@reviewer Addressed in the latest change.",
      }),
    );
    expect(onPosted).toHaveBeenCalledOnce();
  });

  it("uses the same composer shell for replies and Timeline comments", () => {
    usePullRequestMutationStore
      .getState()
      .setCommentDraft(identity, "@reviewer ");

    render(
      <PullRequestIssueCommentComposer
        identity={identity}
        expected={expected}
        capability={{ allowed: true }}
        mutationTransport={transport(vi.fn())}
        readTransport={readTransport()}
        variant="reply"
        replyTo="reviewer"
      />,
    );

    const composer = screen.getByRole("region", { name: "Reply to reviewer" });
    expect(composer).toHaveClass("mt-4");
    expect(composer).not.toHaveClass(
      "-mx-4",
      "-mb-4",
      "border-t",
      "bg-background/25",
    );
    const textbox = screen.getByRole("textbox", { name: "Reply to reviewer" });
    expect(textbox.parentElement).toHaveClass(
      "relative",
      "rounded-xl",
      "bg-muted/50",
      "ring-1",
      "ring-inset",
      "ring-border/60",
    );
    expect(textbox).toHaveClass(
      "min-h-12",
      "max-h-32",
      "field-sizing-content",
      "resize-none",
      "border-0",
      "bg-transparent",
      "pr-20",
    );
    expect(screen.getByRole("button", { name: "Cancel reply" })).toHaveClass(
      "absolute",
      "bottom-2",
      "right-11",
      "size-8",
      "rounded-full",
    );
    expect(screen.getByRole("button", { name: "Post reply" })).toHaveClass(
      "absolute",
      "bottom-2",
      "right-2",
      "size-8",
      "rounded-full",
    );
    expect(
      screen.getByRole("button", { name: "Post reply" }).querySelector("svg"),
    ).toHaveClass("lucide-arrow-up");
  });

  it("preserves text, retries the same key, and keeps outcome-unknown blocked after refresh", async () => {
    const user = userEvent.setup();
    const calls: Array<{ idempotencyKey: string }> = [];
    const postComment = vi.fn().mockImplementation(async (request) => {
      calls.push(request);
      return {
        ok: false,
        error: calls.length === 1
          ? { code: "rate_limited", message: "Slow down" }
          : {
              code: "conflict",
              conflictReason: "outcome_unknown",
              message: "Unknown",
            },
      } satisfies PullRequestPostCommentResult;
    });
    const onRefresh = vi.fn();
    render(
      <PullRequestIssueCommentComposer
        identity={identity}
        expected={expected}
        capability={{ allowed: true }}
        mutationTransport={transport(postComment)}
        readTransport={readTransport()}
        onRefresh={onRefresh}
      />,
    );
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "Retain me");
    await user.click(screen.getByRole("button", { name: "Post comment" }));
    expect(textarea).toHaveValue("Retain me");
    await user.click(screen.getByRole("button", { name: "Retry confirmed effect" }));
    expect(calls[1]?.idempotencyKey).toBe(calls[0]?.idempotencyKey);
    expect(await screen.findByText(/outcome could not be confirmed/i)).toBeVisible();
    expect(textarea).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check remote state" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Post comment" })).toBeDisabled();
    expect(textarea).toHaveValue("Retain me");
  });

  it("blocks comments for an unknown review outcome until a successful explicit refresh", async () => {
    const user = userEvent.setup();
    const postComment = vi.fn();
    const unknownError = {
      code: "conflict" as const,
      conflictReason: "outcome_unknown" as const,
      message: "The remote outcome could not be confirmed.",
    };
    const reviewLane: PullRequestMutationLane = {
      effect: "review",
      status: "error",
      idempotencyKey: "review-receipt",
      request: null,
      error: unknownError,
      result: { ok: false, error: unknownError },
      draftSnapshotKey: null,
      updatedAt: 1,
    };
    const reviewLaneKey = getPullRequestMutationLaneKey(identity, "review");
    usePullRequestMutationStore.setState({ lanes: { [reviewLaneKey]: reviewLane } });
    usePullRequestMutationStore.getState().setCommentDraft(identity, "Wait for certainty");
    const onRefresh = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    render(
      <PullRequestIssueCommentComposer
        identity={identity}
        expected={expected}
        capability={{ allowed: true }}
        mutationTransport={transport(postComment)}
        readTransport={readTransport()}
        onRefresh={onRefresh}
      />,
    );

    const textarea = screen.getByRole("textbox");
    expect(await screen.findByText(/outcome could not be confirmed/i)).toBeVisible();
    expect(textarea).toBeDisabled();
    expect(screen.getByRole("button", { name: "Post comment" })).toBeDisabled();
    expect(postComment).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Check remote state" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Check remote state" })).toBeVisible();
    expect(usePullRequestMutationStore.getState().lanes[reviewLaneKey]).toEqual(reviewLane);

    await user.click(screen.getByRole("button", { name: "Check remote state" }));
    await vi.waitFor(() => {
      expect(usePullRequestMutationStore.getState().lanes[reviewLaneKey]).toBeUndefined();
    });
    expect(textarea).toBeEnabled();
    expect(screen.getByRole("button", { name: "Post comment" })).toBeEnabled();
    expect(postComment).not.toHaveBeenCalled();
  });
});
