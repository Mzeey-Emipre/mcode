import { formatSubagentDisplayName } from "@mcode/contracts";

/** Formats a canonical subagent identity for display without changing its routing value. */
export function formatSubagentIdentity(identity: string): string {
  return formatSubagentDisplayName(identity);
}
