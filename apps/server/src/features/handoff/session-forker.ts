/**
 * Per-Provider session forkers for the chat fork handoff pipeline.
 *
 * Replaces the B/D dispatch that lived inline in
 * {@link HandoffPipelineService.orchestrate}. Each provider owns a `forker`
 * (see {@link IAgentProvider.forker}) that knows how to produce a handoff
 * artifact for that provider's session-fork semantics:
 *
 * - {@link CleanForker} (clean-resume providers, path B + B-prime): runs a
 *   side-channel query against a forked copy of the parent session.
 * - {@link DeterministicForker} (path D): stateless replay-based builder, also
 *   the pipeline's cross-forker fallback when a provider fork fails.
 *
 * The forkers call the providers' concrete `runSideChannelQuery` method
 * directly. That method is intentionally off the {@link IAgentProvider}
 * interface now, so only the forkers reach it.
 */

import type { ForkRequest, HandoffArtifact, HandoffMeta, SessionForker } from "@mcode/contracts";
import { runPathDDeterministic } from "./path-d-deterministic.js";

export type { ForkRequest, SessionForker } from "@mcode/contracts";

/**
 * Structural shape of the Claude provider's concrete `runSideChannelQuery`.
 * Kept narrow so the forker does not depend on the full provider class.
 */
interface CleanForkCapable {
  runSideChannelQuery(args: {
    parentThreadId: string;
    parentSdkSessionId: string;
    prompt: string;
    abortSignal?: AbortSignal;
    conversationHistory?: string;
    cwd: string;
  }): Promise<string>;
  readonly id: string;
}

/**
 * Build a provider-generated artifact (path B) with the given ladder step.
 * Mode is decided by the pipeline (budget-driven) and stamped here; the
 * forkers do not own mode selection.
 */
function buildProviderArtifact(
  req: ForkRequest,
  markdownBody: string,
  step: "B",
): HandoffArtifact {
  const parent = req.parentThread;
  const meta: HandoffMeta = {
    schemaVersion: 1,
    parentThreadId: req.parentThreadId,
    forkedFromMessageId: req.forkedFromMessageId,
    forkAnchorRole: req.forkAnchorRole,
    childThreadId: req.childThreadId,
    generatedBy: "provider",
    provider: parent.provider,
    ladderStep: step,
    mode: "full",
    generatedAt: new Date().toISOString(),
    characterCount: markdownBody.length,
    parentSdkSessionId: parent.sdk_session_id ?? null,
    providerErrorOnGenerate: null,
    regenerationHistory: [],
    attachments: [],
    ...(req.historyBudget && { historyBudget: req.historyBudget }),
  };
  return { markdown: markdownBody, meta };
}

/**
 * Path B (+ B-prime) forker for clean-resume providers. Runs a
 * one-shot side-channel query against a forked copy of the parent session. If
 * `parentSdkSessionId` is missing the provider's own sessionless B-prime
 * fallback (driven by `conversationHistory`) still produces a path-B result.
 */
export class CleanForker implements SessionForker {
  constructor(private readonly provider: CleanForkCapable) {}

  /** Produce a path-B handoff via the provider's side-channel query. */
  async fork(req: ForkRequest): Promise<HandoffArtifact> {
    const text = await this.provider.runSideChannelQuery({
      parentThreadId: req.parentThreadId,
      parentSdkSessionId: req.parentSdkSessionId ?? "",
      prompt: req.prompt,
      abortSignal: req.abortSignal,
      conversationHistory: req.conversationHistory,
      cwd: req.cwd,
    });
    return buildProviderArtifact(req, text, "B");
  }
}

/**
 * Path D forker: stateless, replay-based deterministic builder. Used directly
 * by providers that cannot fork a session and as the pipeline's cross-forker
 * fallback when a provider fork fails or times out.
 */
export class DeterministicForker implements SessionForker {
  /** Produce a path-D handoff from the parent message replay. */
  async fork(req: ForkRequest): Promise<HandoffArtifact> {
    return runPathDDeterministic({
      parentThread: req.parentThread,
      messagesUpToFork: req.messagesUpToFork,
      forkedFromMessageId: req.forkedFromMessageId,
      forkAnchorRole: req.forkAnchorRole,
      childThreadId: req.childThreadId,
      reason: req.forkReason ?? null,
      compactSummary: req.compactSummary ?? null,
      forkAnchorBody: req.forkAnchorBody ?? null,
      toolCallRecords: req.toolCallRecords,
      thoughtSegments: req.thoughtSegments,
      filesChanged: req.filesChanged,
      historyBudget: req.historyBudget,
    });
  }
}
