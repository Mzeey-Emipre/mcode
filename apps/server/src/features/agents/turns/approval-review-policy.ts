import type {
  ApprovalReviewMode,
  IAgentProvider,
  IApprovalReviewCapable,
  InteractionMode,
  PermissionMode,
} from "@mcode/contracts";

/** Provider fields needed to resolve a review decision before dispatch. */
export type ApprovalReviewProvider = Pick<IAgentProvider, "id" | "descriptor"> & Partial<Pick<IApprovalReviewCapable, "getApprovalReviewSupport">>;

/** Frozen review choice for one provider dispatch attempt. */
export interface ApprovalReviewDecision {
  readonly mode: ApprovalReviewMode;
  readonly reason: string;
}

/** Resolves a provider-neutral approval-review choice without changing provider state. */
export class ApprovalReviewPolicy {
  async resolve(input: {
    requestedMode: ApprovalReviewMode | undefined;
    permissionMode: PermissionMode;
    interactionMode: InteractionMode;
    model: string;
    provider: ApprovalReviewProvider;
  }): Promise<ApprovalReviewDecision> {
    if (!input.provider.getApprovalReviewSupport) {
      return { mode: "manual", reason: "provider-does-not-support-approval-review" };
    }
    const support = await input.provider.getApprovalReviewSupport({
      permissionMode: input.permissionMode,
      interactionMode: input.interactionMode,
      requestedMode: input.requestedMode ?? "manual",
      model: input.model,
    });
    if (support.status === "required") return this.resolveRequired(input, support);
    return this.resolveOptional(input, support);
  }

  private resolveRequired(
    input: { requestedMode: ApprovalReviewMode | undefined; permissionMode: PermissionMode },
    support: Awaited<ReturnType<IApprovalReviewCapable["getApprovalReviewSupport"]>>,
  ): ApprovalReviewDecision {
    if (input.requestedMode !== "automatic"
      || input.permissionMode === "full"
      || !support.supportedModes.includes("automatic")) {
      throw new Error(support.reason);
    }
    return { mode: "automatic", reason: support.reason };
  }

  private resolveOptional(
    input: { requestedMode: ApprovalReviewMode | undefined; permissionMode: PermissionMode },
    support: Awaited<ReturnType<IApprovalReviewCapable["getApprovalReviewSupport"]>>,
  ): ApprovalReviewDecision {
    if (input.permissionMode === "full") {
      return { mode: "manual", reason: "full-access-bypasses-approval-review" };
    }
    if (support.status === "available"
      && input.requestedMode === "automatic"
      && support.supportedModes.includes("automatic")) {
      return { mode: "automatic", reason: support.reason };
    }
    return { mode: "manual", reason: input.requestedMode === "automatic" ? support.reason : "manual-requested" };
  }
}
