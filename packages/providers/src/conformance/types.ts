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
  /** Fixture provenance classes required for every declared profile. */
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
