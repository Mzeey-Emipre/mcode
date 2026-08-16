import "reflect-metadata";
import { describe, expect, it } from "vitest";
import * as pullRequests from "../index";

describe("pull requests feature boundary", () => {
  it("exposes only the composition-root pull-request symbols", () => {
    expect(Object.keys(pullRequests).sort()).toStrictEqual([
      "GithubPullRequestClient",
      "GithubService",
      "PullRequestMutationService",
      "PullRequestService",
      "ReviewWorktreeService",
    ]);
  });
});
