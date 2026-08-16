/**
 * Temporary server compatibility path for the private Provider session runtime.
 * Concrete Providers move behind package factories in later rollout tickets.
 */
export {
  SessionRuntime,
  type ProtocolAdapter,
  type SpawnArgs,
  type SpawnResult,
} from "@mcode/providers/server-compat/session-runtime";
