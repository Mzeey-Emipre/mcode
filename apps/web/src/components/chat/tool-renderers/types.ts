import type { ToolCall } from "@/transport/types";

export interface ToolRendererProps {
  toolCall: ToolCall;
  isActive?: boolean;
}
