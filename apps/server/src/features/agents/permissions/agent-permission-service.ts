import {
  PermissionDecisionSchema,
  PermissionRequestSchema,
  type PermissionDecision,
  type PermissionRequest,
} from "@mcode/contracts";
import { inject, injectable } from "tsyringe";
import { AgentService } from "../orchestration/agent-service.js";

/** Composition capability for provider permission decisions and pending state. */
@injectable()
export class AgentPermissionService {
  constructor(@inject(AgentService) private readonly agentService: AgentService) {}

  /** Resolve one provider permission request after contract validation. */
  respondToPermission(requestId: string, decision: PermissionDecision): void {
    const validatedDecision = PermissionDecisionSchema.parse(decision);
    this.agentService.respondToPermission(requestId, validatedDecision);
  }

  /** Return validated provider permission requests for one thread. */
  listPendingPermissions(threadId: string): PermissionRequest[] {
    return this.agentService
      .listPendingPermissions(threadId)
      .map((request) => PermissionRequestSchema().parse(request));
  }
}
