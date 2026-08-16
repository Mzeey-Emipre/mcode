import "reflect-metadata";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { broadcast } from "../../../../transport/push";
import { HandoffCoordinator } from "../handoff-coordinator.js";
import type { HandoffArtifact, LadderStep, ProviderErrorClass } from "@mcode/contracts";

// The coordinator broadcasts UI handoff-status events as part of path selection
// ("generating" -> "ready"/"fallback"). Mock the push module so tests can assert
// which path ran without a live transport.
vi.mock("../../../../transport/push", () => ({ broadcast: vi.fn() }));
const broadcastMock = vi.mocked(broadcast);

/** Build a pipeline-produced artifact for a given ladder step. */
function mkArtifact(
  ladderStep: LadderStep,
  providerErrorOnGenerate: ProviderErrorClass | null = null,
  markdown = "# Handoff\n\nThis paragraph orients the child on the parent thread's goal.",
): HandoffArtifact {
  return {
    markdown,
    meta: {
      schemaVersion: 1,
      parentThreadId: "t_parent",
      forkedFromMessageId: "m_fork",
      forkAnchorRole: "user",
      childThreadId: "t_child",
      generatedBy: ladderStep === "D" ? "deterministic" : "provider",
      provider: "claude",
      ladderStep,
      mode: "full",
      generatedAt: new Date().toISOString(),
      characterCount: markdown.length,
      parentSdkSessionId: "sdk_1",
      providerErrorOnGenerate,
      regenerationHistory: [],
      attachments: [],
    },
  };
}

function mkDeps() {
  return {
    handoffPipeline: { orchestrate: vi.fn(async () => mkArtifact("B")) },
    handoffStorage: {
      write: vi.fn(async () => "artifact_ulid"),
      copyAttachments: vi.fn(async () => []),
    },
    scopedPreGrant: { issue: vi.fn() },
    // Child thread is present and not deleted by default.
    threadRepo: { findById: vi.fn(() => ({ id: "t_child", deleted_at: null }) as any) },
    messageRepo: {
      create: vi.fn(() => ({}) as any),
      listByThread: vi.fn(() => ({ messages: [], hasMore: false }) as any),
    },
    turnSnapshotRepo: { listByThread: vi.fn(() => []) },
    taskRepo: { get: vi.fn(() => []) },
  };
}

const PARENT_THREAD = {
  id: "t_parent",
  title: "Parent Thread",
  provider: "claude",
  sdk_session_id: "sdk_1",
  last_compact_summary: null,
  deleted_at: null,
} as any;

const FORK_MESSAGE = { id: "m_fork", role: "user", sequence: 5, content: "do the thing" } as any;

const FORKED_MESSAGES = [
  { id: "m1", role: "user", content: "hi", sequence: 1, attachments: null },
  { id: "m2", role: "assistant", content: "working on it", sequence: 2, attachments: null },
  FORK_MESSAGE,
] as any;

function mkInput(overrides: Record<string, unknown> = {}) {
  return {
    parentThread: PARENT_THREAD,
    childThreadId: "t_child",
    childProvider: "claude" as const,
    forkMessage: FORK_MESSAGE,
    forkedMessages: FORKED_MESSAGES,
    userMessage: "continue the work please",
    model: "claude-sonnet-4-6",
    ...overrides,
  };
}

/** Find the last `thread.handoff` broadcast payload. */
function lastHandoffStatus() {
  const calls = broadcastMock.mock.calls.filter((c) => c[0] === "thread.handoff");
  return calls[calls.length - 1]?.[1] as any;
}

describe("HandoffCoordinator.deliverHandoff", () => {
  beforeEach(() => {
    broadcastMock.mockClear();
  });

  it("path B: persists the artifact, broadcasts ready, anchors the full doc, delivers off-band", async () => {
    const deps = mkDeps();
    deps.handoffPipeline.orchestrate = vi.fn(async () => mkArtifact("B"));
    const coordinator = HandoffCoordinator.forTesting(deps);

    const { providerWireOverride } = await coordinator.deliverHandoff(mkInput());

    // The pipeline ran with the derived fork anchor role.
    expect(deps.handoffPipeline.orchestrate).toHaveBeenCalledWith(
      expect.objectContaining({ forkAnchorRole: "user", childThreadId: "t_child", childProviderId: "claude" }),
    );
    // Artifact persisted, status "ready" (not fallback).
    expect(deps.handoffStorage.write).toHaveBeenCalledWith("t_child", expect.objectContaining({ meta: expect.objectContaining({ ladderStep: "B" }) }));
    expect(lastHandoffStatus()).toMatchObject({ status: "ready", ladderStep: "B" });
    // Seq-1 anchor holds the FULL markdown, internal-only.
    expect(deps.messageRepo.create).toHaveBeenCalledWith(
      "t_child", "system", expect.stringContaining("# Handoff"), 1,
      undefined, undefined, undefined, undefined, true,
    );
    // Off-band delivery: pointer prompt names the temp file and carries the user message.
    expect(deps.scopedPreGrant.issue).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "t_child", toolName: "Read" }),
    );
    expect(providerWireOverride).toContain("mcode-handoff-t_child-");
    expect(providerWireOverride).toContain("continue the work please");
  });

  it("path D (pipeline-produced): broadcasts fallback with ladderStep D but still uses off-band delivery", async () => {
    const deps = mkDeps();
    deps.handoffPipeline.orchestrate = vi.fn(async () => mkArtifact("D", "quota"));
    const coordinator = HandoffCoordinator.forTesting(deps);

    const { providerWireOverride } = await coordinator.deliverHandoff(mkInput());

    expect(deps.handoffStorage.write).toHaveBeenCalledWith("t_child", expect.objectContaining({ meta: expect.objectContaining({ ladderStep: "D" }) }));
    expect(lastHandoffStatus()).toMatchObject({ status: "fallback", ladderStep: "D", providerErrorOnGenerate: "quota" });
    // A pipeline-produced D is NOT the legacy replay: it ships the doc off-band.
    expect(providerWireOverride).toContain("mcode-handoff-t_child-");
  });

  it("codex child receives the bounded artifact inline instead of a temp-file Read prompt", async () => {
    const deps = mkDeps();
    deps.handoffPipeline.orchestrate = vi.fn(async () => mkArtifact("B"));
    const coordinator = HandoffCoordinator.forTesting(deps);

    const { providerWireOverride } = await coordinator.deliverHandoff(mkInput({ childProvider: "codex" as const }));

    expect(deps.scopedPreGrant.issue).not.toHaveBeenCalled();
    expect(providerWireOverride).toContain("# Handoff");
    expect(providerWireOverride).not.toContain("mcode-handoff-t_child-");
    expect(providerWireOverride).toContain("continue the work please");
  });

  it("codex inline handoff is capped to the first-turn input limit", async () => {
    const deps = mkDeps();
    deps.handoffPipeline.orchestrate = vi.fn(async () => mkArtifact("B", null, `# Handoff\n\n${"x".repeat(20_000)}`));
    const coordinator = HandoffCoordinator.forTesting(deps);

    const { providerWireOverride } = await coordinator.deliverHandoff(mkInput({ childProvider: "codex" as const }));

    expect(deps.scopedPreGrant.issue).not.toHaveBeenCalled();
    expect(providerWireOverride.length).toBeLessThanOrEqual(14_000);
    expect(providerWireOverride).toContain("Inline Codex handoff shortened");
    expect(providerWireOverride).toContain("continue the work please");
  });

  it("legacy-replay fallback: when the pipeline throws, builds a deterministic replay and persists a D artifact", async () => {
    const deps = mkDeps();
    deps.handoffPipeline.orchestrate = vi.fn(async () => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    });
    const coordinator = HandoffCoordinator.forTesting(deps);

    const { providerWireOverride } = await coordinator.deliverHandoff(mkInput());

    // Fallback path runs: status fallback, error classified from the thrown error.
    expect(lastHandoffStatus()).toMatchObject({ status: "fallback", ladderStep: "D", providerErrorOnGenerate: "quota" });
    // The provider receives the inline conversation replay, NOT an off-band pointer.
    expect(providerWireOverride).toContain('continuing work from a previous thread titled "Parent Thread"');
    expect(providerWireOverride).not.toContain("mcode-handoff-t_child-");
    expect(providerWireOverride).toContain("continue the work please");
    // A deterministic D artifact is persisted so "View doc" has something to read.
    expect(deps.handoffStorage.write).toHaveBeenCalledWith(
      "t_child",
      expect.objectContaining({ meta: expect.objectContaining({ generatedBy: "deterministic", ladderStep: "D", providerErrorOnGenerate: "quota" }) }),
    );
  });

  it("throws when the child thread vanishes mid-handoff (does not write an artifact)", async () => {
    const deps = mkDeps();
    deps.handoffPipeline.orchestrate = vi.fn(async () => mkArtifact("B"));
    deps.threadRepo.findById = vi.fn(() => null as any);
    const coordinator = HandoffCoordinator.forTesting(deps);

    await expect(coordinator.deliverHandoff(mkInput())).rejects.toThrow();
    expect(deps.handoffStorage.write).not.toHaveBeenCalled();
  });
});
