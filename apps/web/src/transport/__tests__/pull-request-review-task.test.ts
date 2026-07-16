import { beforeEach, describe, expect, it, vi } from "vitest";

const activeTransport = {
  createPullRequestReviewTask: vi.fn(),
  getPullRequestReviewLink: vi.fn(),
};

vi.mock("../index", () => ({
  getTransport: () => activeTransport,
}));

import { getPullRequestReviewTaskTransport } from "../pull-request-review-task";

const identity = {
  provider: "github" as const,
  repositoryNodeId: "R_repo",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 42,
};

describe("pull request Review-task transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps local Review-task actions on a separate transport seam", async () => {
    activeTransport.createPullRequestReviewTask.mockResolvedValue({ ok: false });
    activeTransport.getPullRequestReviewLink.mockResolvedValue(null);
    const transport = getPullRequestReviewTaskTransport();
    const request = {
      action: "prepare" as const,
      operationId: "review-prepare-1",
      identity,
    };

    await transport.createReviewTask(request);
    await transport.reviewLink({ threadId: "thread-1" });

    expect(activeTransport.createPullRequestReviewTask).toHaveBeenCalledWith(request);
    expect(activeTransport.getPullRequestReviewLink).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
  });
});
