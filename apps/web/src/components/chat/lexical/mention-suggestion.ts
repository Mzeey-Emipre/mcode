import type { MentionSuggestion } from "../useFileAutocomplete";
import { createMentionId, type MentionNodeData } from "./MentionNode";

/** Maps one picker suggestion to the typed Lexical mention data it represents. */
export function createMentionNodeData(item: MentionSuggestion): MentionNodeData {
  if (item.kind === "agent") {
    return {
      id: createMentionId(),
      kind: "agent",
      label: item.label,
      name: item.name,
      path: item.path,
      provider: item.provider,
    };
  }
  if (item.kind === "plugin") {
    return {
      id: createMentionId(),
      kind: "plugin",
      label: item.label,
      name: item.name,
      path: item.path,
    };
  }
  return {
    id: createMentionId(),
    kind: "file",
    label: item.label,
    path: item.path,
  };
}
