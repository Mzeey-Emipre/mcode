import {
  PermissionDecisionSchema,
  PermissionRequestSchema,
  type IProviderRegistry,
  type PermissionRequest,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";

/** Push callbacks used by the Agents permission publication boundary. */
export interface AgentPermissionPublicationDeps {
  providerRegistry: IProviderRegistry;
  publishPermissionRequest: (request: PermissionRequest) => void;
  publishPermissionResolved: (payload: { requestId: string; decision: "allow" | "allow-session" | "deny" | "cancelled" }) => void;
}

/** Subscribe to provider permission events and publish only validated payloads. */
export function publishAgentPermissionEvents({
  providerRegistry,
  publishPermissionRequest,
  publishPermissionResolved,
}: AgentPermissionPublicationDeps): void {
  for (const provider of providerRegistry.resolveAll()) {
    provider.on("permission_request", (request) => {
      const parsed = PermissionRequestSchema().safeParse(request);
      if (!parsed.success) {
        logger.warn("Provider permission request violated its contract", {
          providerId: provider.id,
          error: parsed.error.message,
        });
        return;
      }
      publishPermissionRequest(parsed.data);
    });

    provider.on("permission_resolved", (payload) => {
      const decision = PermissionDecisionSchema.safeParse(payload.decision);
      if (typeof payload.requestId !== "string" || !decision.success) {
        logger.warn("Provider permission resolution violated its contract", {
          providerId: provider.id,
        });
        return;
      }
      publishPermissionResolved({ requestId: payload.requestId, decision: decision.data });
    });
  }
}
