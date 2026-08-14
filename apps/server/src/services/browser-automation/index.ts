/** Browser automation security gateway exports. */
export {
  BrowserAutomationCredentialRegistry,
  type BrowserAutomationCredentialClaims,
  type BrowserAutomationCredentialRegistryOptions,
  type BrowserAutomationCredentialScope,
  type BrowserAutomationPermissionCapability,
  type IssuedBrowserAutomationCredential,
} from "./credential-registry.js";

/** Browser automation host broker exports. */
export {
  BrowserAutomationBroker,
  type BrowserAutomationBrokerOptions,
  type BrowserAutomationDirectedSender,
  type BrowserAutomationHostConnectionAuthorization,
} from "./broker.js";

/** Browser automation loopback MCP endpoint exports. */
export {
  BrowserAutomationMcpHandler,
  type BrowserAutomationMcpHandlerOptions,
} from "./mcp-handler.js";

/** Provider-facing browser permission helpers and session metadata. */
export {
  browserAutomationPermissionCapability,
  type BrowserAutomationCredentialMetadata,
} from "./access-service.js";

/** Provider-neutral browser session lease exports. */
export {
  BrowserAutomationSessionLease,
  type BrowserAutomationSessionLeaseConfiguration,
  type BrowserAutomationSessionLeaseGrant,
  type BrowserAutomationSessionLeaseOptions,
  type BrowserAutomationSessionLeaseRefreshResult,
  type BrowserAutomationSessionLeaseReleaseResult,
  type BrowserAutomationSessionLeaseRequest,
  type BrowserAutomationSessionLeaseScope,
  type BrowserAutomationSessionLeaseStage,
} from "./browser-automation-session-lease.js";

/** Privacy-safe Browser lifecycle telemetry and nightly evidence. */
export {
  BrowserAutomationTelemetry,
  browserAutomationTerminalFields,
  classifyBrowserAutomationFailure,
  type BrowserAutomationFailureBundle,
  type BrowserAutomationFailureClass,
  type BrowserAutomationNightlyEvidenceReport,
  type BrowserAutomationTelemetryEvent,
  type BrowserAutomationTelemetryStage,
  type BrowserAutomationZeroToleranceOutcomes,
} from "./telemetry.js";
