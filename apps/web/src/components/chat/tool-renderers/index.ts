import type { ComponentType } from "react";
import type { ToolRendererProps } from "./types";

import { GlobRenderer } from "./GlobRenderer";
import { ReadRenderer } from "./ReadRenderer";
import { EditRenderer } from "./EditRenderer";
import { WriteRenderer } from "./WriteRenderer";
import { BashRenderer } from "./BashRenderer";
import { GrepRenderer } from "./GrepRenderer";
import { AgentRenderer } from "./AgentRenderer";
import { WebRenderer } from "./WebRenderer";
import { GenericRenderer } from "./GenericRenderer";

const RENDERERS: Record<string, ComponentType<ToolRendererProps>> = {
  Glob: GlobRenderer,
  Read: ReadRenderer,
  Edit: EditRenderer,
  Write: WriteRenderer,
  Bash: BashRenderer,
  Grep: GrepRenderer,
  Agent: AgentRenderer,
  WebSearch: WebRenderer,
  WebFetch: WebRenderer,
};

export function getRenderer(toolName: string): ComponentType<ToolRendererProps> {
  return RENDERERS[toolName] ?? GenericRenderer;
}

export { TOOL_LABELS, TOOL_ICONS, DEFAULT_ICON } from "./constants";
