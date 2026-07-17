import type { ToolCall } from "@/transport/types";

interface ToolOutputTruncationNoticeProps {
  /** Tool call whose output metadata should be summarized. */
  toolCall: ToolCall;
}

/**
 * Shows that a tool output preview was bounded and saved as a runtime artifact.
 */
export function ToolOutputTruncationNotice({ toolCall }: ToolOutputTruncationNoticeProps) {
  if (toolCall.outputTruncated !== true) return null;

  const total = toolCall.outputTotalBytes != null
    ? ` · ${formatBytes(toolCall.outputTotalBytes)} total`
    : "";
  const saved = toolCall.outputArtifactPath ? " · full output saved" : "";

  return (
    <div
      className="max-w-full truncate font-mono text-xs font-normal leading-5 text-muted-foreground/65"
      title={toolCall.outputArtifactPath}
      aria-label={`Output truncated${total}${saved}`}
    >
      Output truncated{total}{saved}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
