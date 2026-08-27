import type { ProviderHostPorts } from "@mcode/providers";
import type { JobObject } from "../../../runtime/process/containment/job-object.js";
import type { EnvService } from "../../../runtime/environment/env-service.js";
import type { ScopedPreGrantService } from "../../agents/permissions/scoped-pre-grant.js";
import type { CanonicalAgentEventSink } from "../../agents/index.js";
import type { BrowserAutomationSessionLease } from "../../browser-automation/index.js";
import type { InternalThreadControlMcpRuntime } from "../../thread-control/index.js";
import { killProcessTree } from "../../../runtime/process/containment/process-kill.js";

/** Server services used to compose the narrow Provider host-port boundary. */
export interface ProviderHostPortDependencies {
  envService: EnvService;
  jobObject: JobObject;
  browser: BrowserAutomationSessionLease;
  threadControl: InternalThreadControlMcpRuntime;
  grants: ScopedPreGrantService;
  events: CanonicalAgentEventSink;
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
        dependencies.events.commit({
          threadId: batch.threadId,
          turnId: batch.turnId,
          executionId: batch.executionId,
          phase: batch.phase,
          nativeCursor: batch.nativeCursor,
          events: batch.events,
        });
      },
    },
  };
}
