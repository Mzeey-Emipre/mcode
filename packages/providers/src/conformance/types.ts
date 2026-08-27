import type {
  CanonicalAgentEventEnvelope,
  ProviderCapabilityName,
} from "@mcode/agent-model";
import type { ProviderBoundary, ProviderFactoryInput } from "../factory-types.js";
import type { ProviderEventDraft } from "../host-ports.js";

/** Current version of the committed Provider conformance fixture contract. */
export const PROVIDER_CONFORMANCE_CONTRACT_VERSION = 1 as const;

/** Core lifecycle coverage or one declared Provider capability profile. */
export type ProviderConformanceProfile = "core" | ProviderCapabilityName;

/** Structural event retained after a raw Provider trace is sanitized. */
export interface SanitizedTraceEvent {
  kind: "session" | "turn" | "item" | "terminal";
  sequence: number;
  nativeId?: string;
  pairId?: string;
  size?: number;
  status?: "started" | "completed" | "interrupted" | "errored";
}

/** Allowlisted native Cursor ACP `session/update` fields safe for committed fixtures. */
export type CursorAcpTraceSessionUpdate =
  | {
    sessionUpdate: "tool_call";
    toolCallId: string;
    title: string;
    kind: "read" | "other";
    status: "pending" | "in_progress";
  }
  | {
    sessionUpdate: "tool_call_update";
    toolCallId: string;
    status: "in_progress" | "completed" | "failed";
  }
  | { sessionUpdate: "session_info_update" };

/** Sanitized native Cursor ACP `session/update` envelope. */
export interface CursorAcpTraceSessionUpdateEnvelope {
  sequence: number;
  kind: "session/update";
  sessionId: string;
  update: CursorAcpTraceSessionUpdate;
}

/** Sanitized native Cursor ACP extension request envelope. */
export type CursorAcpTraceExtMethodEnvelope =
  | {
    sequence: number;
    kind: "ext-method";
    method: "cursor/task";
    params: null | { toolCallId: string };
  }
  | {
    sequence: number;
    kind: "ext-method";
    method: "cursor/create_plan";
    params: { markdown: string };
  }
  | {
    sequence: number;
    kind: "ext-method";
    method: "cursor/continue";
    params: Record<never, never>;
  };

/** Sanitized native Cursor ACP permission request envelope. */
export interface CursorAcpTracePermissionRequestEnvelope {
  sequence: number;
  kind: "request-permission";
  request: {
    sessionId: string;
    options: readonly [{ optionId: string; kind: "allow_once"; name: string }];
    toolCall: { title: string };
  };
}

/** One safe native Cursor ACP envelope replayed without fixture-side synthesis. */
export type CursorAcpTraceEnvelope =
  | CursorAcpTraceSessionUpdateEnvelope
  | CursorAcpTraceExtMethodEnvelope
  | CursorAcpTracePermissionRequestEnvelope;

/** Semantic output expected after Cursor ACP trace replay. */
export interface CursorAcpTraceExpectedSemantics {
  emittedEventTypes: readonly ("toolUse" | "toolResult")[];
  toolNames: readonly ("Read" | "Agent")[];
  planExitCount: number;
  permissionOutcomes: readonly "selected"[];
  unsupportedMethods: readonly ("cursor/task" | "cursor/continue")[];
  ignoredForeignSessionUpdateCount: number;
}

/** Cursor-only ACP evidence that replays through the production mapper and bridge. */
export interface CursorAcpTraceFixture {
  envelopes: readonly CursorAcpTraceEnvelope[];
  expected: CursorAcpTraceExpectedSemantics;
}

/** Semantic result expected from one sanitized Provider trace. */
export interface FixtureExpectedSemantics {
  orderedKinds: readonly SanitizedTraceEvent["kind"][];
  terminal: "completed" | "interrupted" | "errored";
  toolPairs: readonly (readonly [string, string])[];
}

/** Safe, versioned manifest for one offline Provider trace. */
export interface ProviderFixtureManifest {
  contractVersion: typeof PROVIDER_CONFORMANCE_CONTRACT_VERSION;
  providerId: ProviderBoundary["id"];
  cliVersion: string;
  protocolVersion: string;
  provenance: "captured" | "synthetic";
  requiredProfiles: readonly ProviderConformanceProfile[];
  scenario: string;
  sourceHash: string;
  redaction: {
    reviewed: true;
    removedFields: readonly string[];
  };
  input: {
    events: readonly SanitizedTraceEvent[];
    /** Cursor-only ACP envelopes. Generic ACP fixtures remain private. */
    cursorAcpTrace?: CursorAcpTraceFixture;
  };
  expected: FixtureExpectedSemantics;
}

/** Offline source that records the supported and tested runtime versions. */
export interface ProviderVersionEvidence {
  component: string;
  oldestSupported: string;
  currentTested: string;
  source: string;
}

/** Registry entry that binds one enabled factory to its required evidence. */
export interface ProviderConformanceRegistration {
  providerId: ProviderBoundary["id"];
  factory(input: ProviderFactoryInput): ProviderBoundary;
  requiredProfiles: readonly ProviderConformanceProfile[];
  fixtureFiles: readonly string[];
  /** Fixture provenance classes required for the Provider's collective evidence. */
  requiredFixtureProvenance?: readonly ProviderFixtureManifest["provenance"][];
  supportedVersions: readonly ProviderVersionEvidence[];
}

/** Adapter seam used to replay native protocol input into canonical drafts. */
export interface ProviderFixtureMapper<TInput> {
  map(input: TInput): readonly ProviderEventDraft[];
}

/** Result from the deterministic canonical sink used by factory profiles. */
export interface DeterministicSinkSnapshot {
  events: readonly CanonicalAgentEventEnvelope[];
  diagnostics: readonly string[];
}
