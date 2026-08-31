import type {
  AgentEventRouting,
  CanonicalAgentEvent,
  ProviderIdentity,
} from "@mcode/agent-model";
import type { InteractionMode } from "@mcode/contracts";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";

/** Provider event input submitted to the server-owned canonical event sink. */
export interface ProviderEventDraft {
  eventId: string;
  routing: AgentEventRouting;
  sourceProviderId: string;
  sourceIdentities: readonly ProviderIdentity[];
  sourceSequence?: number;
  providerTimestamp?: string;
  ingestClass?: "volatile";
  payload: CanonicalAgentEvent;
}

/** Supplies one server-owned environment snapshot to a Provider session spawn. */
export interface ProviderEnvironmentPort {
  snapshot(): Readonly<Record<string, string>>;
}

/** Supplies immutable facts about the Node runtime that hosts providers. */
export interface ProviderRuntimePort extends HostRuntime {}

/** Attaches and terminates child process trees without exposing the server process service. */
export interface ProviderProcessPort {
  attach(pid: number, description: string): void;
  terminateTree(pid: number): Promise<void>;
}

/** Non-secret metadata retained for one browser credential. */
export interface ProviderBrowserCredentialMetadata {
  credentialId: string;
  expiresAt: number;
}

/** Minimal browser lease request passed to the server-owned browser authority. */
export interface ProviderBrowserLeaseRequest {
  providerId: string;
  providerSessionId: string;
  mcodeSessionId: string;
  threadId: string;
  workspaceId: string;
  permissionCapability: "observe" | "interact" | "privileged";
}

/** Opaque browser lease handle returned by the server. */
export interface ProviderBrowserLeaseHandle {
  leaseId: string;
  expiresAt: number;
}

/** Browser credential issued for one staged Provider lease. */
export interface ProviderBrowserLeaseGrant extends ProviderBrowserCredentialMetadata {
  leaseId: string;
  mcpUrl: string;
  token: string;
  allowedOperations: readonly string[];
}

/** Result of rotating credentials for an active browser lease. */
export type ProviderBrowserLeaseRefreshResult =
  | { ok: true; grant: ProviderBrowserLeaseGrant }
  | { ok: false; leaseId: string; reason: "not-found" | "unconfigured" | "issuance-failed" };

/** Gives a Provider scoped access to server-owned browser leases. */
export interface ProviderBrowserPort {
  stage(request: ProviderBrowserLeaseRequest): ProviderBrowserLeaseHandle;
  releaseSession(providerId: string, mcodeSessionId: string): number;
  isConfigured(): boolean;
  issue(stage: ProviderBrowserLeaseHandle): ProviderBrowserLeaseGrant | null;
  refresh(leaseId: string): ProviderBrowserLeaseRefreshResult;
  release(leaseId: string): { leaseId: string; released: boolean; credentialId?: string };
  revokeCredential(credentialId: string): boolean;
}

/** Input for one server-owned thread-control bootstrap. */
export interface ProviderThreadControlRequest {
  providerId: string;
  sessionId: string;
  threadId: string;
  turnId?: string;
  protocol: "claude" | "codex" | "http";
}

/** Authenticated HTTP MCP connection supplied by the server-owned thread-control authority. */
export interface ProviderThreadControlHttpConnection {
  name: string;
  url: string;
  headers: Record<string, string>;
}

/** Gives a Provider opaque thread-control bootstrap data for one scoped session. */
export interface ProviderThreadControlPort {
  bootstrap(request: ProviderThreadControlRequest): Promise<unknown | null>;
  close(sessionId: string): Promise<void>;
}

/** Maps Mcode turn controls to the browser gateway capability. */
export function providerBrowserPermissionCapability(
  permissionMode: string,
  interactionMode: InteractionMode,
): "observe" | "interact" | "privileged" {
  if (interactionMode === "plan") return "observe";
  return permissionMode === "full" ? "privileged" : "interact";
}

/** Consumes a server-authorized, path-scoped grant. */
export interface ProviderGrantPort {
  consume(request: { threadId: string; toolName: string; path: string }): boolean;
}

/** Submits bounded semantic drafts to the server-owned canonical event sink. */
export interface ProviderEventSinkPort {
  submit(batch: ProviderEventBatch): Promise<ProviderEventSubmissionReceipt>;
}

/** One bounded provider batch submitted through the canonical server sink. */
export interface ProviderEventBatch {
  threadId: string;
  turnId: string;
  executionId: string;
  phase: string;
  nativeCursor?: unknown;
  events: readonly ProviderEventDraft[];
}

/** Durable result for one provider event submission. */
export interface ProviderEventCommitReceipt {
  outcome: "committed" | "duplicate" | "conflict" | "ingest-overflow";
  conversationRevision: number;
  rosterRevision: number;
  acceptedThrough: number;
  durableThrough: number;
  eventCount: number;
}

/** Delivery state for canonical runtime events after a durable submission. */
export type ProviderEventDeliveryStatus = "queued" | "not-required";

/** Separates durable commit state from the subsequent ingress handoff. */
export interface ProviderEventSubmissionReceipt {
  commit: ProviderEventCommitReceipt;
  delivery: {
    ingress: ProviderEventDeliveryStatus;
  };
}

/** Narrow server services that Provider implementations can use. */
export interface ProviderHostPorts {
  runtime: ProviderRuntimePort;
  environment: ProviderEnvironmentPort;
  processes: ProviderProcessPort;
  browser: ProviderBrowserPort;
  threadControl: ProviderThreadControlPort;
  grants: ProviderGrantPort;
  events: ProviderEventSinkPort;
}
