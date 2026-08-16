/** Handles thread creation, deletion, worktree provisioning, and lifecycle. */
export { ThreadService } from "./lifecycle/thread-service.js";

/** Coordinates provider-neutral cross-thread actions. */
export { ThreadControlService } from "./authority/thread-control-service.js";

/** Reserves threads for serialized control mutations. */
export { ThreadControlMutationReservationService } from "./authority/thread-control-mutation-reservation-service.js";

/** Authorizes internal provider thread-control MCP sessions. */
export { InternalThreadControlMcpAuthority } from "./authority/thread-control-mcp-authority.js";

/** Hosts internal provider thread-control MCP sessions. */
export {
  InternalThreadControlMcpRuntime,
  type InternalThreadControlMcpHttpConnection,
} from "./authority/thread-control-mcp-runtime.js";

/** Manages external thread-control pairings. */
export { ExternalThreadControlPairingService } from "./external/external-thread-control-pairing-service.js";

/** Hosts external thread-control MCP requests. */
export {
  EXTERNAL_THREAD_CONTROL_MCP_PATH,
  ExternalThreadControlMcpRuntime,
} from "./external/external-thread-control-mcp-runtime.js";

/** Tears down provider and terminal resources for a thread. */
export { ThreadTeardownService } from "./lifecycle/thread-teardown-service.js";

/** Owns durable thread completion and reopen transitions. */
export { ThreadCompletionService } from "./lifecycle/thread-completion-service.js";
