import { Lifecycle, type DependencyContainer } from "tsyringe";

import { ClaudeProvider } from "../adapters/claude/claude-provider.js";
import { CopilotProvider } from "../adapters/copilot/copilot-provider.js";
import { ProviderRegistry } from "./provider-registry.js";
import { createProviderHostPorts } from "./provider-host-ports.js";
import { BrowserAutomationSessionLease } from "../../browser-automation/index.js";
import { InternalThreadControlMcpRuntime } from "../../thread-control/index.js";
import { CanonicalAgentEventSink } from "../../agents/index.js";
import { ScopedPreGrantService } from "../../agents/permissions/scoped-pre-grant.js";
import { EnvService } from "../../../runtime/environment/env-service.js";
import type { JobObject } from "../../../runtime/process/containment/job-object.js";
import { CursorLegacyEventBridge } from "./cursor-legacy-event-bridge.js";

/** Register provider adapters, the provider registry, and provider host ports. */
export function registerProviderAdapters(container: DependencyContainer): void {
  container.register(
    CursorLegacyEventBridge,
    { useClass: CursorLegacyEventBridge },
    { lifecycle: Lifecycle.Singleton },
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
    ProviderRegistry,
    { useClass: ProviderRegistry },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IProviderRegistry", {
    useFactory: (c) => c.resolve(ProviderRegistry),
  });
  container.register("ProviderHostPorts", {
    useFactory: (c) => createProviderHostPorts({
      envService: c.resolve(EnvService),
      jobObject: c.resolve<JobObject>("JobObject"),
      browser: c.resolve(BrowserAutomationSessionLease),
      threadControl: c.resolve(InternalThreadControlMcpRuntime),
      grants: c.resolve(ScopedPreGrantService),
      events: c.resolve(CanonicalAgentEventSink),
      cursorLegacyEvents: c.resolve(CursorLegacyEventBridge),
    }),
  });
}
