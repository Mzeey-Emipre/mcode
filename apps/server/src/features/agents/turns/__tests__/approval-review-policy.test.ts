import { describe, expect, it } from "vitest";
import type { ApprovalReviewSupport } from "@mcode/contracts";
import { ApprovalReviewPolicy, type ApprovalReviewProvider } from "../approval-review-policy.js";

function provider(support: ApprovalReviewSupport): ApprovalReviewProvider {
  return {
    id: "cursor",
    descriptor: { id: "cursor", capabilities: [{ name: "approval-review", support: "supported" }] },
    getApprovalReviewSupport: async () => support,
  };
}

const automatic: ApprovalReviewSupport = {
  status: "available", supportedModes: ["manual", "automatic"], reason: "automatic-review-available", liveChangeScope: "none",
};

describe("ApprovalReviewPolicy", () => {
  it("uses automatic only when the provider reports it available", async () => {
    await expect(new ApprovalReviewPolicy().resolve({ requestedMode: "automatic", permissionMode: "supervised", interactionMode: "build", model: "test", provider: provider(automatic) }))
      .resolves.toEqual({ mode: "automatic", reason: "automatic-review-available" });
  });

  it("keeps unsupported automatic requests manual with a stable fallback reason", async () => {
    const unavailable: ApprovalReviewSupport = { status: "unavailable", supportedModes: ["manual"], reason: "automatic-review-unavailable", liveChangeScope: "none" };
    await expect(new ApprovalReviewPolicy().resolve({ requestedMode: "automatic", permissionMode: "supervised", interactionMode: "build", model: "test", provider: provider(unavailable) }))
      .resolves.toEqual({ mode: "manual", reason: "automatic-review-unavailable" });
  });

  it("blocks a managed required review even when Full Access was requested", async () => {
    const required: ApprovalReviewSupport = { status: "required", supportedModes: ["manual", "automatic"], reason: "automatic-review-required", liveChangeScope: "none" };
    await expect(new ApprovalReviewPolicy().resolve({ requestedMode: "manual", permissionMode: "full", interactionMode: "build", model: "test", provider: provider(required) }))
      .rejects.toThrow("automatic-review-required");
    await expect(new ApprovalReviewPolicy().resolve({ requestedMode: "automatic", permissionMode: "full", interactionMode: "build", model: "test", provider: provider(required) }))
      .rejects.toThrow("automatic-review-required");
    await expect(new ApprovalReviewPolicy().resolve({ requestedMode: "manual", permissionMode: "supervised", interactionMode: "build", model: "test", provider: provider(required) }))
      .rejects.toThrow("automatic-review-required");
    await expect(new ApprovalReviewPolicy().resolve({ requestedMode: "automatic", permissionMode: "supervised", interactionMode: "build", model: "test", provider: provider(required) }))
      .resolves.toEqual({ mode: "automatic", reason: "automatic-review-required" });
  });
});
