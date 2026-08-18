/** Formats a canonical subagent identity for display without changing its routing value. */
export function formatSubagentIdentity(identity: string): string {
  const sentence = identity.trim().replace(/_+/g, " ").replace(/\s+/g, " ");
  if (sentence.length === 0) return "Subagent";
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}
