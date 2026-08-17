/** Persists and reads thread handoff artifacts. */
export { HandoffStorage } from "./persistence/handoff-storage.js";

/** Runs the provider handoff pipeline. */
export { HandoffPipelineService } from "./orchestration/handoff-pipeline.js";

/** Coordinates handoff delivery and recovery. */
export { HandoffCoordinator } from "./orchestration/handoff-coordinator.js";

/** Forks provider sessions through the clean continuation path. */
export { CleanForker } from "./providers/session-forker.js";

/** Owns branch creation and checkout-state synchronization for thread handoffs. */
export { HandoffCheckoutService } from "./checkout/handoff-checkout-service.js";
