import { useMemo } from "react";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import type { ProviderId } from "@mcode/contracts";

interface ComposerSurfaceStateInput {
  readonly threadId?: string;
  readonly workspaceId?: string;
  readonly isNewThread: boolean;
  readonly branchFromMessageId?: string;
  readonly activeThread?: {
    readonly clientPreparing?: boolean;
    readonly clientError?: string | null;
    readonly provider?: string | null;
    readonly worktree_path?: string | null;
  };
  readonly composerMode: string;
  readonly provider: string;
  readonly hasDraftContent: boolean;
  readonly isAgentRunning: boolean;
}

function useProviderSurfaceState(provider: ProviderId) {
  const availability = useProviderAvailabilityStore((state) =>
    state.getAvailability(provider),
  );
  const unavailable = Boolean(
    availability && (!availability.enabled || availability.cli.status === "not_found"),
  );

  return {
    providerReason: unavailable
      ? !availability?.enabled
        ? "disabled" as const
        : "cli_missing" as const
      : null,
  };
}

function useCatalogScope(input: ComposerSurfaceStateInput) {
  const catalogThreadId = input.activeThread?.clientPreparing || input.isNewThread
    ? undefined
    : input.threadId;
  const selectedWorktreePath = useWorkspaceStore(
    (state) => state.selectedWorktree?.path,
  );
  const catalogCwd = input.activeThread?.clientPreparing
    ? undefined
    : input.isNewThread && input.composerMode === "existing-worktree"
      ? selectedWorktreePath
      : input.activeThread?.worktree_path ?? undefined;

  return { catalogThreadId, catalogCwd };
}

function getComposerLocks(input: ComposerSurfaceStateInput) {
  return {
    isThreadScaffold: Boolean(
      input.activeThread?.clientPreparing || input.activeThread?.clientError,
    ),
    isModelFullyLocked: input.isAgentRunning && !input.branchFromMessageId,
    isProviderLocked: Boolean(
      input.threadId && !input.isNewThread && !input.branchFromMessageId
        && input.activeThread?.provider,
    ),
  };
}

/** Derives display-only composer state from the active session and renderer stores. */
export function useComposerSurfaceState(input: ComposerSurfaceStateInput) {
  const annotationScopeId = input.threadId ?? input.workspaceId;
  const annotationRows = usePreviewAnnotationStore((state) =>
    annotationScopeId ? state.byThread[annotationScopeId] : undefined,
  );
  const diffAnnotationRows = usePreviewAnnotationStore((state) =>
    annotationScopeId ? state.diffByThread[annotationScopeId] : undefined,
  );
  const annotationCount =
    (annotationRows?.length ?? 0) + (diffAnnotationRows?.length ?? 0);
  const annotationBundleForDisplay = useMemo(
    () => annotationScopeId
      ? usePreviewAnnotationStore.getState().buildBundle(annotationScopeId)
      : undefined,
    [annotationRows, annotationScopeId, diffAnnotationRows],
  );
  const effectiveProviderId = input.provider as ProviderId;
  const providerSurfaceState = useProviderSurfaceState(effectiveProviderId);
  const catalogScope = useCatalogScope(input);
  const composerLocks = getComposerLocks(input);

  return {
    annotationScopeId,
    annotationBundleForDisplay,
    ...catalogScope,
    ...composerLocks,
    effectiveProviderId,
    hasContent: input.hasDraftContent || annotationCount > 0,
    ...providerSurfaceState,
  };
}
