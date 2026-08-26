import { describe, it, expect } from "vitest";
import { PERMISSION_MODES, INTERACTION_MODES } from "@/transport";
import type { ComposerDraft } from "@/stores/composerDraftStore";
import { resolveComposerSession, snapshotComposerDraft } from "./index";

const globalDefaults = {
  interactionMode: INTERACTION_MODES.BUILD,
  permissionMode: PERMISSION_MODES.FULL,
};

const threadSettings = {
  interactionMode: INTERACTION_MODES.PLAN,
  permissionMode: PERMISSION_MODES.SUPERVISED,
  copilotAgent: "code-review",
  contextWindow: "1m" as const,
  thinking: true,
  codexFastMode: false,
};

describe("resolveComposerSession", () => {
  it("returns global defaults for new-thread mode", () => {
    const session = resolveComposerSession({
      threadId: undefined,
      getDraft: () => undefined,
      threadRow: undefined,
      threadSettings,
      globalDefaults,
    });

    expect(session.input).toBe("");
    expect(session.attachments).toEqual([]);
    expect(session.interactionMode).toBe(INTERACTION_MODES.BUILD);
    expect(session.permissionMode).toBe(PERMISSION_MODES.FULL);
    expect(session.copilotAgent).toBeNull();
  });

  it("restores a saved draft with thread settings for mode fields", () => {
    const draft: ComposerDraft = {
      input: "hello draft",
      attachments: [],
      modelId: "claude-sonnet-4-20250514",
      provider: "claude",
      reasoning: "medium",
      codexFastMode: true,
    };

    const session = resolveComposerSession({
      threadId: "thread-a",
      getDraft: (id) => (id === "thread-a" ? draft : undefined),
      threadRow: undefined,
      threadSettings,
      globalDefaults,
    });

    expect(session.input).toBe("hello draft");
    expect(session.modelId).toBe("claude-sonnet-4-20250514");
    expect(session.interactionMode).toBe(INTERACTION_MODES.PLAN);
    expect(session.codexFastMode).toBe(true);
  });

  it("restores one selected-text comment without sharing its source range", () => {
    const draft: ComposerDraft = {
      input: "",
      attachments: [],
      modelId: "claude-sonnet-4-20250514",
      reasoning: "medium",
      selectedTextComments: [{
        id: "550e8400-e29b-41d4-a716-446655440003",
        displayNumber: 1,
        source: {
          threadId: "thread-a",
          messageId: "assistant-1",
          sourceRole: "assistant",
          start: 3,
          end: 8,
          quote: "focus",
        },
        note: "Explain this.",
        mentions: [],
      }],
    };

    const session = resolveComposerSession({
      threadId: "thread-a",
      getDraft: () => draft,
      threadRow: undefined,
      threadSettings,
      globalDefaults,
    });

    expect(session.selectedTextComments).toEqual(draft.selectedTextComments);
    expect(session.selectedTextComments[0]?.source).not.toBe(draft.selectedTextComments?.[0]?.source);
  });

  it("uses thread row defaults when no draft exists", () => {
    const session = resolveComposerSession({
      threadId: "thread-b",
      getDraft: () => undefined,
      threadRow: {
        id: "thread-b",
        model: "gpt-4.1",
        provider: "openai",
        reasoning_level: "high",
        interaction_mode: "build",
        permission_mode: "full",
        copilot_agent: null,
        context_window_mode: null,
        thinking: null,
        codex_fast_mode: null,
      } as never,
      threadSettings,
      globalDefaults,
    });

    expect(session.input).toBe("");
    expect(session.provider).toBe("openai");
    expect(session.interactionMode).toBe(INTERACTION_MODES.BUILD);
  });
});

describe("snapshotComposerDraft", () => {
  it("copies attachments without sharing array or object references", () => {
    const draft: ComposerDraft = {
      input: "x",
      attachments: [{
        id: "a1",
        name: "f.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        previewUrl: "",
        filePath: null,
      }],
      modelId: "m",
      reasoning: "none",
    };
    const snap = snapshotComposerDraft(draft);
    expect(snap.attachments).not.toBe(draft.attachments);
    expect(snap.attachments[0]).not.toBe(draft.attachments[0]);
    expect(snap.attachments).toEqual(draft.attachments);
  });
});
