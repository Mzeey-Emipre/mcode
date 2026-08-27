import type { ProviderHostPorts } from "@mcode/providers";
import type { JobObject } from "../../../runtime/process/containment/job-object.js";
import type { EnvService } from "../../../runtime/environment/env-service.js";
import type { ScopedPreGrantService } from "../../agents/permissions/scoped-pre-grant.js";
import type { CanonicalAgentBoundary } from "../../agents/index.js";
import type { BrowserAutomationSessionLease } from "../../browser-automation/index.js";
import type { InternalThreadControlMcpRuntime } from "../../thread-control/index.js";
import { killProcessTree } from "../../../runtime/process/containment/process-kill.js";
import type { CanonicalLegacyEventBridge } from "./canonical-legacy-event-bridge.js";

/** Server services used to compose the narrow Provider host-port boundary. */
export interface ProviderHostPortDependencies {
  envService: EnvService;
  jobObject: JobObject;
  browser: BrowserAutomationSessionLease;
  threadControl: InternalThreadControlMcpRuntime;
  grants: ScopedPreGrantService;
  events: CanonicalAgentBoundary;
  legacyEvents: CanonicalLegacyEventBridge;
}

/** Adapts server-owned services to the only host operations exposed to Providers. */
export function createProviderHostPorts(
  dependencies: ProviderHostPortDependencies,
): ProviderHostPorts {
  return {
    environment: {
      snapshot: () => dependencies.envService.getEnv(),
    },
    processes: {
      attach: (pid, description) => {
        if (!dependencies.jobObject.isWindowsJob) return;
        dependencies.jobObject.assign(pid);
        dependencies.jobObject.setDescription(pid, description);
      },
      terminateTree: (pid) => killProcessTree(pid),
    },
    browser: {
      stage: (request) => dependencies.browser.stage(request),
      releaseSession: (providerId, sessionId) =>
        dependencies.browser.releaseSession(providerId, sessionId),
      isConfigured: () => dependencies.browser.isConfigured(),
      issue: (stage) => {
        const grant = dependencies.browser.issue(stage);
        if (!grant) return null;
        return {
          leaseId: grant.leaseId,
          mcpUrl: grant.mcpUrl,
          token: grant.token,
          credentialId: grant.credentialId,
          expiresAt: grant.expiresAt,
          allowedOperations: [...grant.allowedOperations],
        };
      },
      refresh: (leaseId) => dependencies.browser.refresh(leaseId),
      release: (leaseId) => dependencies.browser.release(leaseId),
      revokeCredential: (credentialId) => dependencies.browser.revokeCredential(credentialId),
    },
    threadControl: {
      bootstrap: async (request) => {
        switch (request.protocol) {
          case "claude":
            return dependencies.threadControl.createClaudeServer(request.sessionId) ?? null;
          case "codex":
            return await dependencies.threadControl.createCodexConfiguration(request.sessionId) ?? null;
          case "http":
            return await dependencies.threadControl.createHttpConnection(request.sessionId) ?? null;
          default: {
            const unsupportedProtocol: never = request.protocol;
            throw new Error(`Unsupported Provider thread-control protocol: ${String(unsupportedProtocol)}`);
          }
        }
      },
      close: (sessionId) => dependencies.threadControl.close(sessionId),
    },
    grants: {
      consume: (request) => dependencies.grants.tryConsume(request),
    },
    events: {
      submit: async (batch) => {
        const result = dependencies.events.commit({
          threadId: batch.threadId,
          turnId: batch.turnId,
          executionId: batch.executionId,
          phase: batch.phase,
          nativeCursor: batch.nativeCursor,
          events: batch.events,
        });
        const legacyDelivery = deliverLegacyProjection(dependencies.legacyEvents, result);
        return {
          commit: {
            outcome: providerCommitOutcome(result.outcome),
            conversationRevision: result.conversationRevision,
            rosterRevision: result.rosterRevision,
            acceptedThrough: result.acceptedThrough,
            durableThrough: result.durableThrough,
            eventCount: result.events.length,
          },
          delivery: {
            canonical: result.canonicalDelivery
              ?? (result.events.length > 0 ? "published" : "not-required"),
            legacy: legacyDelivery,
          },
        };
      },
    },
  };
}

function providerCommitOutcome(
  outcome: "committed" | "duplicate" | "conflict" | "terminal-outcome-confirmed" | "ingest-overflow",
): "committed" | "duplicate" | "conflict" | "ingest-overflow" {
  if (outcome === "terminal-outcome-confirmed") return "duplicate";
  return outcome;
}

function deliverLegacyProjection(
  bridge: CanonicalLegacyEventBridge,
  result: ReturnType<CanonicalAgentBoundary["commit"]>,
): "published" | "deferred" | "not-required" {
  if (result.outcome !== "committed" || result.events.length === 0) return "not-required";
  try {
    bridge.deliver(result.events);
    return "published";
  } catch {
    return "deferred";
  }
}
