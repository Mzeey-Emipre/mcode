import type { InteractionMode } from "@mcode/contracts";
import type { BrowserAutomationPermissionCapability } from "./credential-registry.js";

/** Non-secret metadata retained with a live provider session. */
export interface BrowserAutomationCredentialMetadata {
  credentialId: string;
  expiresAt: number;
}

/** Maps turn controls onto the browser gateway's three permission classes. */
export function browserAutomationPermissionCapability(
  permissionMode: string,
  interactionMode: InteractionMode,
): BrowserAutomationPermissionCapability {
  if (interactionMode === "plan") return "observe";
  return permissionMode === "full" ? "privileged" : "interact";
}
