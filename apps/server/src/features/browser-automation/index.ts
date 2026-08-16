/** Routes browser automation operations to visible renderer hosts. */
export {
  BrowserAutomationBroker,
  type BrowserAutomationHostConnectionAuthorization,
} from "../../services/browser-automation/broker.js";

/** Stores and revokes browser automation credentials. */
export { BrowserAutomationCredentialRegistry } from "../../services/browser-automation/credential-registry.js";

/** Handles the browser automation loopback MCP endpoint. */
export { BrowserAutomationMcpHandler } from "../../services/browser-automation/mcp-handler.js";

/** Coordinates provider browser automation session leases. */
export { BrowserAutomationSessionLease } from "../../services/browser-automation/browser-automation-session-lease.js";

/** Records bounded browser automation lifecycle telemetry. */
export { BrowserAutomationTelemetry } from "../../services/browser-automation/telemetry.js";
