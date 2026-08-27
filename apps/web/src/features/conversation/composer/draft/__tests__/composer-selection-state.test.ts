import { describe, expect, it } from "vitest";
import {
  mergeComposerAgentSelection,
  type ComposerAgentSelection,
} from "../composer-selection-state";

const selection: ComposerAgentSelection = {
  modelId: "gpt-5.6-luna",
  provider: "codex",
  reasoning: "high",
  interactionMode: "build",
  permissionMode: "full",
  orchestrationMode: "standard",
  copilotAgent: null,
  contextWindow: null,
  thinking: null,
  codexFastMode: null,
};

describe("mergeComposerAgentSelection", () => {
  it("keeps the current state when a defaults patch changes nothing", () => {
    expect(mergeComposerAgentSelection(selection, {
      modelId: selection.modelId,
      provider: selection.provider,
      reasoning: selection.reasoning,
      interactionMode: selection.interactionMode,
      permissionMode: selection.permissionMode,
    })).toBe(selection);
  });
});
