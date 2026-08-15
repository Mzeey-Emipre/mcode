/** Conversation-facing selectors over the broader thread state. */
export {
  useThreadRecord,
  useActiveThreadRecord,
  readThreadRecord,
} from "@/stores/thread-selectors";

/** Reads the active thread record and its handoff status for conversation views. */
export { getThreadRecord, getHandoffStatus } from "@/stores/thread-record";
