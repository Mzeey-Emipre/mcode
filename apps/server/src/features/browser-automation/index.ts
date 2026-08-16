/** Routes browser automation operations to visible renderer hosts. */
export {
  BrowserAutomationBroker,
  type BrowserAutomationHostConnectionAuthorization,
} from "./broker.js";

/** Stores and revokes browser automation credentials. */
export { BrowserAutomationCredentialRegistry } from "./credential-registry.js";

/** Handles the browser automation loopback MCP endpoint. */
export { BrowserAutomationMcpHandler } from "./mcp-handler.js";

/** Maps provider permission settings to browser automation capability. */
export {
  browserAutomationPermissionCapability,
  type BrowserAutomationCredentialMetadata,
} from "./access-service.js";

/** Coordinates provider browser automation session leases. */
export {
  BrowserAutomationSessionLease,
  type BrowserAutomationSessionLeaseGrant,
  type BrowserAutomationSessionLeaseScope,
  type BrowserAutomationSessionLeaseStage,
} from "./browser-automation-session-lease.js";

/** Records bounded browser automation lifecycle telemetry. */
export { BrowserAutomationTelemetry } from "./telemetry.js";
