import { Lifecycle, type DependencyContainer } from "tsyringe";
import { hostRuntime } from "@mcode/shared/node/host-runtime";

import { ClaudeProvider } from "../adapters/claude/claude-provider.js";
import { CopilotProvider } from "../adapters/copilot/copilot-provider.js";
import { OpenCodeProvider } from "../adapters/opencode/opencode-provider.js";
import { ProviderRegistry } from "./provider-registry.js";
import { createProviderHostPorts } from "./provider-host-ports.js";
import { BrowserAutomationSessionLease } from "../../browser-automation/index.js";
import { InternalThreadControlMcpRuntime } from "../../thread-control/index.js";
import { CanonicalAgentBoundary } from "../../agents/index.js";
import { ScopedPreGrantService } from "../../agents/permissions/scoped-pre-grant.js";
import { EnvService } from "../../../runtime/environment/env-service.js";
import type { JobObject } from "../../../runtime/process/containment/job-object.js";
import { CodexCollaborationEventAdapter } from "../../agents/collaboration/adapters/codex-collaboration-event-adapter.js";
import {
  logProviderEventIngressDiagnostic,
  PROVIDER_EVENT_INGRESS_DIAGNOSTIC_SINK,
  ProviderEventIngress,
  type ProviderEventIngressDiagnosticSink,
} from "./provider-event-ingress.js";
import { CODEX_PROVIDER_EVENT_ADAPTER, type ProviderEventAdapter } from "./provider-event-adapter.js";

/** Register provider adapters, the provider registry, and provider host ports. */
export function registerProviderAdapters(container: DependencyContainer): void {
  container.register(
    CodexCollaborationEventAdapter,
    { useClass: CodexCollaborationEventAdapter },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register<ProviderEventAdapter>(CODEX_PROVIDER_EVENT_ADAPTER, {
    useFactory: (c) => c.resolve(CodexCollaborationEventAdapter),
  });
  container.register(
    ProviderEventIngress,
    { useClass: ProviderEventIngress },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register<ProviderEventIngressDiagnosticSink>(
    PROVIDER_EVENT_INGRESS_DIAGNOSTIC_SINK,
    { useValue: logProviderEventIngressDiagnostic },
  );
  container.register(
    ClaudeProvider,
    { useClass: ClaudeProvider },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IAgentProvider", {
    useFactory: (c) => c.resolve(ClaudeProvider),
  });
  container.register(
    CopilotProvider,
    { useClass: CopilotProvider },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IAgentProvider", {
    useFactory: (c) => c.resolve(CopilotProvider),
  });
  container.register(
    OpenCodeProvider,
    { useClass: OpenCodeProvider },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IAgentProvider", {
    useFactory: (c) => c.resolve(OpenCodeProvider),
  });
  container.register(
    ProviderRegistry,
    { useClass: ProviderRegistry },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IProviderRegistry", {
    useFactory: (c) => c.resolve(ProviderRegistry),
  });
  container.register("ProviderHostPorts", {
    useFactory: (c) => createProviderHostPorts({
      runtime: hostRuntime,
      envService: c.resolve(EnvService),
      jobObject: c.resolve<JobObject>("JobObject"),
      browser: c.resolve(BrowserAutomationSessionLease),
      threadControl: c.resolve(InternalThreadControlMcpRuntime),
      grants: c.resolve(ScopedPreGrantService),
      events: c.resolve(CanonicalAgentBoundary),
      ingress: c.resolve(ProviderEventIngress),
    }),
  });
}
