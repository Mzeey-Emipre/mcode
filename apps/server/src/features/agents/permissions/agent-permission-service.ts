import {
  PermissionDecisionSchema,
  PermissionRequestSchema,
  type PermissionDecision,
  type PermissionRequest,
  type IProviderRegistry,
} from "@mcode/contracts";
import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";

/** Composition capability for provider permission decisions and pending state. */
@injectable()
export class AgentPermissionService {
  constructor(@inject("IProviderRegistry") private readonly providers: IProviderRegistry) {}

  /** Resolve one provider permission request after contract validation. */
  respondToPermission(requestId: string, decision: PermissionDecision): void {
    const validatedDecision = PermissionDecisionSchema.parse(decision);
    for (const provider of this.providers.resolveAll()) {
      if (provider.resolvePermission?.(requestId, validatedDecision)) return;
    }
    logger.warn("permission.respond: no provider holds requestId %s", requestId);
  }

  /** Return validated provider permission requests for one thread. */
  listPendingPermissions(threadId: string): PermissionRequest[] {
    return this.providers.resolveAll().flatMap((provider) => (
      provider.listPendingPermissions?.(threadId) ?? []
    )).map((request) => PermissionRequestSchema().parse(request));
  }
}
