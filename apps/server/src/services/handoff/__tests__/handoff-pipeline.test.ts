import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { IProviderRegistry } from "@mcode/contracts";
import { HandoffPipelineService } from "../handoff-pipeline.js";
import { CleanForker, DeterministicForker } from "../session-forker.js";

/**
 * Wrap a partial Claude-like mock (with runSideChannelQuery) in a real
 * CleanForker so tests exercise the new forker dispatch end-to-end.
 */
function withCleanForker<T extends { runSideChannelQuery: (...a: any[]) => any }>(p: T) {
  return { ...p, forker: new CleanForker(p as any) };
}

/** Attach a DeterministicForker to a provider with no fork capability. */
function withDeterministicForker<T extends object>(p: T) {
  return { ...p, forker: new DeterministicForker() };
}

function mkDeps() {
  const parent = { id: "t_parent", title: "X", provider: "claude", sdk_session_id: "sdk_1", deleted_at: null, workspace_id: "ws_1", worktree_path: null } as any;
  const child = { id: "t_child", provider: "claude", deleted_at: null } as any;
  return {
    threadRepo: {
      findById: vi.fn(async (id) => (id === "t_parent" ? parent : id === "t_child" ? child : null)),
    },
    messageRepo: {
      listIncludingInternal: vi.fn(async () => [
        { id: "m_1", thread_id: "t_parent", role: "user", content: "hi", sequence: 1, is_internal: false },
      ]),
    },
    providerRegistry: {
      resolve: vi.fn(),
    } satisfies Pick<IProviderRegistry, "resolve">,
    workspaceRepo: {
      findById: vi.fn(async (id) => (id === "ws_1" ? { id: "ws_1", path: "/tmp/test-workspace" } : null)),
    },
  };
}

const BASE_REQ = {
  parentThreadId: "t_parent",
  forkedFromMessageId: "m_1",
  forkAnchorRole: "user" as const,
  childThreadId: "t_child",
  childProviderId: "claude",
  messagesUpToFork: [
    { id: "m_1", thread_id: "t_parent", role: "user", content: "hi", sequence: 1, is_internal: false },
  ] as any,
  userFollowUpMessage: "What should I do next?",
};

describe("HandoffPipelineService.orchestrate", () => {
  it("path B success builds a provider artifact with ladderStep B", async () => {
    const deps = mkDeps();
    deps.providerRegistry.resolve = vi.fn((id: string) => {
      if (id === "claude") {
        return withCleanForker({
          sessionForkOnResume: "clean",
          maxInputCharactersPerTurn: 180_000,
          id: "claude",
          runSideChannelQuery: vi.fn(async () => "# Handoff\n\n## Goal\nX"),
        });
      }
      return null;
    });
    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate(BASE_REQ);
    expect(r.meta.ladderStep).toBe("B");
    expect(r.meta.generatedBy).toBe("provider");
  });

  it("path B quota failure falls directly to D, skipping A", async () => {
    const deps = mkDeps();
    deps.providerRegistry.resolve = vi.fn(() => withCleanForker({
      sessionForkOnResume: "clean",
      maxInputCharactersPerTurn: 180_000,
      id: "claude",
      runSideChannelQuery: vi.fn(async () => {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }),
    }));
    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate(BASE_REQ);
    expect(r.meta.ladderStep).toBe("D");
    expect(r.meta.providerErrorOnGenerate).toBe("quota");
  });

  it("clean-resume provider keeps mode full after off-band delivery", async () => {
    const deps = mkDeps();
    deps.providerRegistry.resolve = vi.fn(() => withCleanForker({
      sessionForkOnResume: "clean",
      // A small child cap no longer downgrades the doc: off-band delivery
      // (PRD #538) retired the minimal mode and the per-turn char budget.
      maxInputCharactersPerTurn: 4_000,
      id: "claude",
      runSideChannelQuery: vi.fn(async () => "# Handoff\n\n## Goal\nX"),
    }));
    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate(BASE_REQ);
    expect(r.meta.ladderStep).toBe("B");
    expect(r.meta.mode).toBe("full");
  });

  it("unsupported-resume provider skips to D with reason null", async () => {
    const deps = mkDeps();
    deps.providerRegistry.resolve = vi.fn(() => withDeterministicForker({
      sessionForkOnResume: "unsupported",
      maxInputCharactersPerTurn: 16_000,
      id: "codex",
    }));
    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate({
      ...BASE_REQ,
      childProviderId: "codex",
    });
    expect(r.meta.ladderStep).toBe("D");
    expect(r.meta.providerErrorOnGenerate).toBeNull();
  });

  // 17.1: missing sdk_session_id falls through to D for path B (session needed
  // for resume).
  it("falls to D when parent has no sdkSessionId and provider is clean-resume", async () => {
    const deps = mkDeps();
    // Override parent to have no session id
    const parentNoSession = { id: "t_parent", title: "X", provider: "claude", sdk_session_id: null, deleted_at: null, workspace_id: "ws_1", worktree_path: null };
    deps.threadRepo.findById = vi.fn(async (id) => (id === "t_parent" ? parentNoSession : null));
    const provider = withCleanForker({
      sessionForkOnResume: "clean",
      maxInputCharactersPerTurn: 180_000,
      id: "claude",
      runSideChannelQuery: vi.fn(async () => "should not be called"),
    });
    deps.providerRegistry.resolve = vi.fn(() => provider);
    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate(BASE_REQ);
    expect(r.meta.ladderStep).toBe("D");
    // runSideChannelQuery must not have been called
    expect(provider.runSideChannelQuery).not.toHaveBeenCalled();
  });

  // 17.2: when the AbortSignal fires (simulating the 60s timeout expiry),
  // the pipeline catches the abort and falls to D with reason "transient".
  it("falls to D when side-channel query rejects because abort signal fired", async () => {
    const deps = mkDeps();
    // Provider that rejects immediately when its signal is already aborted,
    // simulating what a real provider does when the 60s AbortController fires.
    deps.providerRegistry.resolve = vi.fn(() => withCleanForker({
      sessionForkOnResume: "clean",
      maxInputCharactersPerTurn: 180_000,
      id: "claude",
      runSideChannelQuery: vi.fn(async (args: { abortSignal?: AbortSignal }) => {
        if (args.abortSignal?.aborted) {
          throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
        }
        // Should not reach here in this test
        return "unexpected";
      }),
    }));

    // Patch AbortController so its signal is pre-aborted, triggering the
    // pipeline's abort-detection branch without waiting 60 real seconds.
    const OriginalAbortController = globalThis.AbortController;
    globalThis.AbortController = class {
      signal: AbortSignal;
      constructor() {
        const ctrl = new OriginalAbortController();
        ctrl.abort(); // pre-abort
        this.signal = ctrl.signal;
      }
      abort() {}
    } as unknown as typeof AbortController;

    try {
      const svc = HandoffPipelineService.forTesting(deps);
      const r = await svc.orchestrate(BASE_REQ);
      expect(r.meta.ladderStep).toBe("D");
    } finally {
      globalThis.AbortController = OriginalAbortController;
    }
  });
});
