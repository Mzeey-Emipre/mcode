/** Agent orchestration service used by the server composition roots. */
export { AgentService } from "./orchestration/agent-service.js";

/** Agent permission capability used by the server composition roots. */
export { AgentPermissionService } from "./permissions/agent-permission-service.js";

/** Canonical agent event sink used by the server composition roots. */
export { CanonicalAgentEventSink } from "./canonical/canonical-agent-event-sink.js";

/** Publishes canonical agent events for the server composition roots. */
export { publishCanonicalAgentEvents } from "./canonical/canonical-agent-event-sink.js";

/** Reconciles unfinished agent turns after a server restart. */
export { TurnRecoveryService } from "./recovery/turn-recovery-service.js";

/** Persists temporary durable text for unfinished parent assistant responses. */
export { ParentAssistantTextCheckpointService } from "./turns/parent-assistant-text-checkpoint-service.js";

/** Starts agent execution and normalized provider-event publication. */
export { startAgentOrchestration } from "./orchestration/start-agent-orchestration.js";

/** Resolves provider/model targets for delegated thread creation. */
export { DelegationTargetResolver } from "./collaboration/delegation-target-resolver.js";
