/**
 * Shared types for the chat fork handoff pipeline.
 *
 * These now live canonically in `@mcode/contracts` (providers/session-forker)
 * so the {@link IAgentProvider} interface can reference the forker contract.
 * This module re-exports them and adds the pipeline-only {@link HandoffRequest}
 * so existing server-side imports keep working unchanged.
 */

export type {
  LadderStep,
  HandoffMode,
  ForkAnchorRole,
  ProviderErrorClass,
  HandoffMeta,
  HandoffArtifact,
  ForkHistoryBudget,
} from "@mcode/contracts";

import type { ForkAnchorRole, ForkHistoryBudget, Message } from "@mcode/contracts";

/** Input to the pipeline's orchestrate() method. */
export interface HandoffRequest {
  parentThreadId: string;
  forkedFromMessageId: string;
  forkAnchorRole: ForkAnchorRole;
  childThreadId: string;
  childProviderId: string;
  /** Parent messages retained under the fork history budget, ascending. */
  messagesUpToFork: Message[];
  /** Byte-budget metadata for the retained parent history window. */
  historyBudget?: ForkHistoryBudget;
  /** The user's new message in the fork composer that the child agent will receive as its first turn. */
  userFollowUpMessage: string;
}
