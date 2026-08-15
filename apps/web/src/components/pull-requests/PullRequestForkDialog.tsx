import type {
  PullRequestCreateReviewTaskResult,
  PullRequestDetail,
  PullRequestError,
  PullRequestWorkspaceCandidate,
  WorktreeInfo,
} from "@mcode/contracts";
import type { Thread } from "@/transport";
import { AlertCircle, GitFork } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "@/features/conversation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { useOverviewStore } from "@/stores/overviewStore";
import { useToastStore } from "@/stores/toastStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import {
  getPullRequestReviewTaskTransport,
  type PullRequestReviewTaskTransport,
} from "@/transport/pull-request-review-task";

/** Whether a fork opens after creation or remains in the background. */
export type PullRequestForkMode = "foreground" | "background";

interface ForkTarget {
  workspaceId: string;
  mode: "worktree" | "existing-worktree";
  branch: string;
  worktree: WorktreeInfo | null;
}

interface PreviousWorkspaceContext {
  workspaceId: string | null;
  threadId: string | null;
}

let operationSequence = 0;
const PREPARE_TIMEOUT_MS = 20_000;

function createOperationId(): string {
  operationSequence += 1;
  return `pr-fork-prepare-${Date.now().toString(36)}-${operationSequence.toString(36)}`;
}

async function prepareWithinTimeout(
  operation: Promise<PullRequestCreateReviewTaskResult>,
): Promise<PullRequestCreateReviewTaskResult> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error("Project and worktree lookup timed out. Retry in a moment."),
      );
    }, PREPARE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

function errorCopy(error: PullRequestError): string {
  if (error.code === "workspace_mapping_missing") {
    return "No project matches this repository. Add the repository as a project, then retry.";
  }
  if (error.code === "workspace_mapping_ambiguous") {
    return "More than one project matches this repository. Choose the project for this fork.";
  }
  return error.message;
}

function targetFromResult(
  result: Extract<PullRequestCreateReviewTaskResult, { ok: true }>,
): ForkTarget {
  if (result.status === "ready") {
    return {
      workspaceId: result.reviewLink.workspaceId,
      mode: "existing-worktree",
      branch: result.reviewLink.localBranch,
      worktree: {
        name: result.reviewLink.localBranch,
        path: result.reviewLink.worktreePath,
        branch: result.reviewLink.localBranch,
        managed: result.reviewLink.worktreeManaged,
      },
    };
  }
  if (result.status === "existing_worktree") {
    return {
      workspaceId: result.workspace.id,
      mode: "existing-worktree",
      branch: result.worktree.branch,
      worktree: {
        name: result.worktree.name,
        path: result.worktree.path,
        branch: result.worktree.branch,
        managed: result.worktree.managed,
      },
    };
  }
  return {
    workspaceId: result.workspace.id,
    mode: "worktree",
    branch: result.source.head.name,
    worktree: null,
  };
}

/** Props for the pull request fork composer. */
export interface PullRequestForkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: PullRequestDetail;
  mode: PullRequestForkMode;
  /** Optional task prompt focused on a selected review comment. */
  initialPrompt?: string;
  transport?: PullRequestReviewTaskTransport;
}

/** Opens the standard Composer against the project and worktree resolved for a pull request. */
export function PullRequestForkDialog({
  open,
  onOpenChange,
  detail,
  mode,
  initialPrompt,
  transport,
}: PullRequestForkDialogProps) {
  const [target, setTarget] = useState<ForkTarget | null>(null);
  const [error, setError] = useState<PullRequestError | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [preparing, setPreparing] = useState(false);
  const generationRef = useRef(0);
  const previousContextRef = useRef<PreviousWorkspaceContext | null>(null);
  const completedRef = useRef(false);

  const restorePreviousContext = useCallback((): void => {
    const previous = previousContextRef.current;
    if (!previous) return;
    const workspace = useWorkspaceStore.getState();
    workspace.setPendingNewThread(false);
    if (workspace.activeWorkspaceId !== previous.workspaceId) {
      workspace.setActiveWorkspace(previous.workspaceId, undefined, false);
    }
    workspace.setActiveThread(previous.threadId);
  }, []);

  const configureComposer = useCallback(
    (nextTarget: ForkTarget): void => {
      const workspace = useWorkspaceStore.getState();
      workspace.beginNewThread(nextTarget.workspaceId);
      workspace.setNewThreadMode(nextTarget.mode);
      if (nextTarget.mode === "existing-worktree" && nextTarget.worktree) {
        workspace.setSelectedWorktree(nextTarget.worktree);
      } else {
        workspace.setNewThreadBranchFromPr(nextTarget.branch);
      }
      useComposerDraftStore
        .getState()
        .setPendingPrefill(
          initialPrompt ??
            `Review PR #${detail.identity.number}: ${detail.title}`,
        );
      setTarget(nextTarget);
      setPreparing(false);
    },
    [detail.identity.number, detail.title, initialPrompt],
  );

  const prepare = useCallback(
    async (workspaceId?: string): Promise<void> => {
      const generation = ++generationRef.current;
      setPreparing(true);
      setTarget(null);
      setError(null);
      try {
        const result = await prepareWithinTimeout(
          (transport ?? getPullRequestReviewTaskTransport()).createReviewTask({
            action: "prepare",
            operationId: createOperationId(),
            identity: detail.identity,
            ...(workspaceId ? { workspaceId } : {}),
          }),
        );
        if (generationRef.current !== generation) return;
        if (!result.ok) {
          setError(result.error);
          setSelectedWorkspaceId(
            result.error.workspaceCandidates?.[0]?.id ?? null,
          );
          setPreparing(false);
          return;
        }
        configureComposer(targetFromResult(result));
      } catch (caught) {
        if (generationRef.current !== generation) return;
        setError({
          code: "remote_unavailable",
          message:
            caught instanceof Error
              ? caught.message.slice(0, 512)
              : "Pull request fork preparation failed.",
        });
        setPreparing(false);
      }
    },
    [configureComposer, detail.identity, transport],
  );

  useEffect(() => {
    if (!open) {
      generationRef.current += 1;
      return;
    }
    const workspace = useWorkspaceStore.getState();
    previousContextRef.current = {
      workspaceId: workspace.activeWorkspaceId,
      threadId: workspace.activeThreadId,
    };
    completedRef.current = false;
    setSelectedWorkspaceId(null);
    void prepare();
  }, [open, prepare]);

  const close = useCallback(
    (nextOpen: boolean): void => {
      if (nextOpen) {
        onOpenChange(true);
        return;
      }
      generationRef.current += 1;
      if (!completedRef.current) restorePreviousContext();
      onOpenChange(false);
    },
    [onOpenChange, restorePreviousContext],
  );

  const handleThreadCreated = useCallback(
    (thread: Thread): void => {
      completedRef.current = true;
      const workspace = useWorkspaceStore.getState();
      workspace.recordPullRequestLink(
        thread.id,
        detail.identity.number,
        detail.url,
        detail.state,
      );
      if (mode === "background") {
        restorePreviousContext();
        useToastStore
          .getState()
          .show(
            "info",
            "Fork started",
            "The task is running in the background.",
          );
      } else {
        useOverviewStore.getState().requestOpen(thread.id);
        useUiStore.getState().setPrimarySurface("chat");
      }
      onOpenChange(false);
    },
    [
      detail.identity.number,
      detail.state,
      detail.url,
      mode,
      onOpenChange,
      restorePreviousContext,
    ],
  );

  const candidates = error?.workspaceCandidates ?? [];
  const selectedWorkspace = candidates.find(
    (candidate) => candidate.id === selectedWorkspaceId,
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="w-[min(96vw,860px)] gap-0 overflow-hidden p-0 sm:max-w-[860px]">
        <header className="flex items-start gap-3 border-b border-border/45 bg-page px-5 py-4 pr-12">
          <GitFork
            size={18}
            aria-hidden
            className="mt-0.5 shrink-0 text-primary/85"
          />
          <div className="min-w-0">
            <DialogTitle className="text-sm">
              {mode === "background"
                ? "Fork in background"
                : "Fork pull request"}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs leading-5">
              Choose the task context, attach files or images, then send.
            </DialogDescription>
          </div>
        </header>

        {preparing ? (
          <div className="flex min-h-56 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Spinner size="xs" aria-hidden />
            <span role="status">Finding the matching project and worktree</span>
          </div>
        ) : error ? (
          <div className="space-y-4 px-5 py-5">
            <div
              role="alert"
              className="flex items-start gap-2 bg-destructive/8 px-3 py-2.5 text-xs"
            >
              <AlertCircle
                size={14}
                aria-hidden
                className="mt-0.5 shrink-0 text-destructive"
              />
              <p className="text-foreground/85">{errorCopy(error)}</p>
            </div>

            {error.code === "workspace_mapping_ambiguous" &&
            candidates.length > 0 ? (
              <div className="space-y-1.5">
                <label
                  className="text-xs text-muted-foreground"
                  htmlFor="fork-workspace"
                >
                  Project
                </label>
                <Select
                  value={selectedWorkspaceId}
                  onValueChange={setSelectedWorkspaceId}
                >
                  <SelectTrigger id="fork-workspace" className="w-full">
                    <SelectValue>
                      {selectedWorkspace
                        ? selectedWorkspace.name
                        : "Choose a project"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map(
                      (candidate: PullRequestWorkspaceCandidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              {error.code === "workspace_mapping_missing" ? (
                <Button
                  onClick={() => {
                    close(false);
                    requestAnimationFrame(() => {
                      useCommandPaletteStore
                        .getState()
                        .open({ intent: "addProject" });
                    });
                  }}
                >
                  Add project
                </Button>
              ) : (
                <Button
                  disabled={
                    error.code === "workspace_mapping_ambiguous" &&
                    !selectedWorkspaceId
                  }
                  onClick={() => void prepare(selectedWorkspaceId ?? undefined)}
                >
                  Retry
                </Button>
              )}
            </div>
          </div>
        ) : target ? (
          <div className="min-h-0 bg-background">
            <div className="flex items-center gap-2 border-b border-border/35 px-5 py-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/85">
                {target.mode === "existing-worktree"
                  ? "Existing worktree"
                  : "New worktree"}
              </span>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate font-mono">
                {target.branch}
              </span>
              {mode === "background" ? (
                <span className="ml-auto shrink-0">
                  The pull request stays open
                </span>
              ) : null}
            </div>
            <Composer
              isNewThread
              workspaceId={target.workspaceId}
              onThreadCreated={handleThreadCreated}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
