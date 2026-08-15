import type { ToolCall } from "@/transport/types";

/**
 * Short label derived from tool input for narrative rows (path tail, pattern, command, etc.).
 */
export function extractToolInputDetail(tc: ToolCall): string {
  const input = tc.toolInput;
  if (typeof input.file_path === "string")
    return input.file_path.split("/").pop() ?? input.file_path;
  if (typeof input.path === "string") return input.path.split("/").pop() ?? input.path;
  if (typeof input.pattern === "string") return `"${input.pattern}"`;
  if (typeof input.query === "string") return `"${input.query}"`;
  if (typeof input.command === "string") return input.command;
  if (typeof input.description === "string") return input.description;
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length < 100) return v;
  }
  return tc.toolName;
}
