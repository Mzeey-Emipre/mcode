import { HANDOFF_MARKER } from "@mcode/contracts";

export { HANDOFF_MARKER, parseHandoffJson } from "@mcode/contracts";
export type { HandoffMetadata } from "@mcode/contracts";

/** Check whether a message is a handoff system message. */
export function isHandoffMessage(role: string, content: string): boolean {
  return role === "system" && content.includes(HANDOFF_MARKER);
}
