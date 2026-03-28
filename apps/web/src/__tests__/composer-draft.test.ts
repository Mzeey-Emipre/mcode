import { describe, it, expect, beforeEach } from "vitest";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import type { ComposerDraft } from "@/stores/composerDraftStore";

describe("composerDraftStore", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ drafts: {} });
  });

  it("returns undefined for a thread with no draft", () => {
    const draft = useComposerDraftStore.getState().getDraft("thread-1");
    expect(draft).toBeUndefined();
  });

  it("saves and retrieves a draft for a thread", () => {
    const draft: ComposerDraft = {
      input: "Hello world",
      attachments: [],
      modelId: "claude-sonnet-4-6",
      reasoning: "high",
    };

    useComposerDraftStore.getState().saveDraft("thread-1", draft);
    const retrieved = useComposerDraftStore.getState().getDraft("thread-1");

    expect(retrieved).toEqual(draft);
  });

  it("keeps drafts for different threads independent", () => {
    const draftA: ComposerDraft = {
      input: "Draft A",
      attachments: [],
      modelId: "claude-sonnet-4-6",
      reasoning: "high",
    };
    const draftB: ComposerDraft = {
      input: "Draft B",
      attachments: [],
      modelId: "claude-haiku-4-5-20251001",
      reasoning: "low",
    };

    const { saveDraft, getDraft } = useComposerDraftStore.getState();
    saveDraft("thread-a", draftA);
    saveDraft("thread-b", draftB);

    expect(getDraft("thread-a")).toEqual(draftA);
    expect(getDraft("thread-b")).toEqual(draftB);
  });

  it("overwrites a draft when saved again for the same thread", () => {
    const { saveDraft, getDraft } = useComposerDraftStore.getState();

    saveDraft("thread-1", {
      input: "First",
      attachments: [],
      modelId: "claude-sonnet-4-6",
      reasoning: "high",
    });

    saveDraft("thread-1", {
      input: "Second",
      attachments: [],
      modelId: "claude-opus-4-6",
      reasoning: "medium",
    });

    const retrieved = getDraft("thread-1");
    expect(retrieved?.input).toBe("Second");
    expect(retrieved?.modelId).toBe("claude-opus-4-6");
  });

  it("clears a single thread draft", () => {
    const { saveDraft, clearDraft, getDraft } = useComposerDraftStore.getState();

    saveDraft("thread-1", {
      input: "Keep me",
      attachments: [],
      modelId: "claude-sonnet-4-6",
      reasoning: "high",
    });
    saveDraft("thread-2", {
      input: "Delete me",
      attachments: [],
      modelId: "claude-sonnet-4-6",
      reasoning: "high",
    });

    clearDraft("thread-2");

    expect(getDraft("thread-1")).toBeDefined();
    expect(getDraft("thread-2")).toBeUndefined();
  });

  it("does not save empty drafts (no input, no attachments)", () => {
    const { saveDraft, getDraft } = useComposerDraftStore.getState();

    saveDraft("thread-1", {
      input: "",
      attachments: [],
      modelId: "claude-sonnet-4-6",
      reasoning: "high",
    });

    expect(getDraft("thread-1")).toBeUndefined();
  });

  it("preserves attachments in the draft", () => {
    const { saveDraft, getDraft } = useComposerDraftStore.getState();

    const attachments = [
      {
        id: "att-1",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 1024,
        previewUrl: "blob:http://localhost/abc",
        filePath: "/tmp/screenshot.png",
      },
    ];

    saveDraft("thread-1", {
      input: "Check this image",
      attachments,
      modelId: "claude-sonnet-4-6",
      reasoning: "high",
    });

    const retrieved = getDraft("thread-1");
    expect(retrieved?.attachments).toHaveLength(1);
    expect(retrieved?.attachments[0].name).toBe("screenshot.png");
  });
});

describe("composerDraftStore integration patterns", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ drafts: {} });
  });

  it("simulates thread switch: save A, restore B (empty), switch back to A", () => {
    const { saveDraft, getDraft } = useComposerDraftStore.getState();

    // User types in thread A
    saveDraft("thread-a", {
      input: "Work in progress",
      attachments: [],
      modelId: "claude-sonnet-4-6",
      reasoning: "high",
    });

    // Switch to thread B: no draft saved
    expect(getDraft("thread-b")).toBeUndefined();

    // Switch back to thread A: draft restored
    const restored = getDraft("thread-a");
    expect(restored?.input).toBe("Work in progress");
  });

  it("simulates send: draft is cleared after message send", () => {
    const { saveDraft, clearDraft, getDraft } = useComposerDraftStore.getState();

    saveDraft("thread-1", {
      input: "About to send",
      attachments: [],
      modelId: "claude-sonnet-4-6",
      reasoning: "high",
    });

    // Simulate send
    clearDraft("thread-1");

    expect(getDraft("thread-1")).toBeUndefined();
  });

  it("clearing a non-existent draft does not throw", () => {
    const { clearDraft } = useComposerDraftStore.getState();
    expect(() => clearDraft("nonexistent")).not.toThrow();
  });
});

describe("draft cleanup on thread deletion", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ drafts: {} });
  });

  it("clearDraft removes the draft entry entirely from the map", () => {
    const { saveDraft, clearDraft } = useComposerDraftStore.getState();

    saveDraft("thread-del", {
      input: "Will be deleted",
      attachments: [],
      modelId: "claude-sonnet-4-6",
      reasoning: "high",
    });

    clearDraft("thread-del");

    // Verify the key is gone, not just undefined
    expect("thread-del" in useComposerDraftStore.getState().drafts).toBe(false);
  });
});
