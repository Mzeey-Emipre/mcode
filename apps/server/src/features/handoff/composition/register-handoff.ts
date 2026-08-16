import { Lifecycle, type DependencyContainer } from "tsyringe";

import {
  HandoffCheckoutService,
  HandoffCoordinator,
  HandoffPipelineService,
  HandoffStorage,
} from "../index.js";

/** Register handoff storage, pipeline, coordination, and checkout services. */
export function registerHandoffServices(container: DependencyContainer): void {
  container.register(
    HandoffStorage,
    { useClass: HandoffStorage },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    HandoffPipelineService,
    { useClass: HandoffPipelineService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    HandoffCoordinator,
    { useClass: HandoffCoordinator },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    HandoffCheckoutService,
    { useClass: HandoffCheckoutService },
    { lifecycle: Lifecycle.Singleton },
  );
}
