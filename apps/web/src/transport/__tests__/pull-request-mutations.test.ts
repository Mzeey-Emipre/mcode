import { beforeEach, describe, expect, it, vi } from "vitest";

const activeTransport = {
  postPullRequestComment: vi.fn(),
  submitPullRequestReview: vi.fn(),
  setPullRequestReadiness: vi.fn(),
  closePullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
};

vi.mock("../index", () => ({ getTransport: () => activeTransport }));

import { getPullRequestMutationTransport } from "../pull-request-mutations";

const identity = {
  provider: "github" as const,
  repositoryNodeId: "R_repo",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 42,
};
const expected = {
  providerNodeId: "PR_42",
  state: "open" as const,
  readiness: "ready" as const,
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};

describe("pull request mutation transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const method of Object.values(activeTransport)) {
      method.mockResolvedValue({ ok: false });
    }
  });

  it("forwards five separately named non-cancellable methods", async () => {
    const transport = getPullRequestMutationTransport();
    const common = { identity, expected, idempotencyKey: crypto.randomUUID() };
    const comment = { ...common, body: "Review note" };
    const review = { ...common, event: "approve" as const, drafts: [] };
    const readiness = { ...common, readiness: "draft" as const };
    const close = common;
    const merge = { ...common, method: "squash" as const };

    await transport.postComment(comment);
    await transport.submitReview(review);
    await transport.setReadiness(readiness);
    await transport.close(close);
    await transport.merge(merge);

    expect(activeTransport.postPullRequestComment).toHaveBeenCalledWith(comment);
    expect(activeTransport.submitPullRequestReview).toHaveBeenCalledWith(review);
    expect(activeTransport.setPullRequestReadiness).toHaveBeenCalledWith(readiness);
    expect(activeTransport.closePullRequest).toHaveBeenCalledWith(close);
    expect(activeTransport.mergePullRequest).toHaveBeenCalledWith(merge);
    expect(activeTransport).not.toHaveProperty("cancelPullRequestMutation");
  });
});
