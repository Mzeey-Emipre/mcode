/** Marker used to detect handoff system messages. */
export const HANDOFF_MARKER = "<!-- mcode-handoff";

/** Structured handoff metadata parsed from the HTML comment block. */
export interface HandoffMetadata {
  parentThreadId: string;
  parentTitle: string;
  forkedFromMessageId: string;
  sourceProvider: string;
  sourceModel: string | null;
  sourceBranch: string;
  sourceWorktreePath: string | null;
  sourceHead: string | null;
  recentFilesChanged: string[];
  openTasks: Array<{ content: string; status: string }>;
}

/** Check whether a message is a handoff system message. */
export function isHandoffMessage(role: string, content: string): boolean {
  return role === "system" && content.includes(HANDOFF_MARKER);
}

/** Extract and parse the HandoffMetadata JSON from a message content string. */
export function parseHandoffJson(content: string): HandoffMetadata | null {
  const startIdx = content.indexOf(HANDOFF_MARKER);
  if (startIdx === -1) return null;

  const jsonStart = startIdx + HANDOFF_MARKER.length;
  const endIdx = content.indexOf("-->", jsonStart);
  if (endIdx === -1) return null;

  const jsonStr = content.slice(jsonStart, endIdx).trim();
  try {
    return JSON.parse(jsonStr) as HandoffMetadata;
  } catch {
    return null;
  }
}
