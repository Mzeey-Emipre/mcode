import {
  PULL_REQUEST_REVIEW_INTENT_MAX_LENGTH,
  PULL_REQUEST_REVIEW_WORKTREE_NAME_MAX_LENGTH,
  type PullRequestCreateReviewTaskResult,
  type PullRequestError,
  type PullRequestIdentity,
  type PullRequestReviewLink,
  type PullRequestReviewSource,
  type PullRequestReviewWorktreeCandidate,
  type PullRequestWorkspaceCandidate,
} from "@mcode/contracts";
import { AlertCircle, GitBranch, GitPullRequest, MapPin } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useOverviewStore } from "@/stores/overviewStore";
import { useToastStore } from "@/stores/toastStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import {
  getPullRequestReviewTaskTransport,
  type PullRequestReviewTaskTransport,
} from "@/transport/pull-request-review-task";

type PreparedReviewTask = Extract<
  PullRequestCreateReviewTaskResult,
  { ok: true; status: "confirmation_required" | "existing_worktree" }
>;

type DialogPhase = "idle" | "preparing" | "ready" | "submitting" | "navigating";

let operationSequence = 0;

function createOperationId(action: "prepare" | "create" | "reuse"): string {
  operationSequence += 1;
  return `pr-review-${action}-${Date.now().toString(36)}-${operationSequence.toString(36)}`;
}

function defaultIntent(): string {
  return "Review this change stack.";
}

function reviewTaskError(caught: unknown, fallback: string): PullRequestError {
  return {
    code: "remote_unavailable",
    message: caught instanceof Error ? caught.message.slice(0, 512) : fallback,
  };
}

function prepareReviewTaskRequest(
  transport: PullRequestReviewTaskTransport,
  identity: PullRequestIdentity,
  workspaceId?: string,
) {
  return transport.createReviewTask({
    action: "prepare",
    operationId: createOperationId("prepare"),
    identity,
    ...(workspaceId ? { workspaceId } : {}),
  });
}

function createReviewTaskRequest(
  prepared: PreparedReviewTask,
  identity: PullRequestIdentity,
  worktreeName: string,
  intent: string,
) {
  if (prepared.status === "confirmation_required") {
    return {
      action: "create_new" as const,
      operationId: createOperationId("create"),
      identity,
      workspaceId: prepared.workspace.id,
      expectedHeadOid: prepared.source.expectedHeadOid,
      worktreeName,
      intent,
    };
  }
  return {
    action: "reuse_existing" as const,
    operationId: createOperationId("reuse"),
    identity,
    workspaceId: prepared.workspace.id,
    expectedHeadOid: prepared.source.expectedHeadOid,
    candidateId: prepared.worktree.candidateId,
    intent,
  };
}

function isValidWorktreeName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= PULL_REQUEST_REVIEW_WORKTREE_NAME_MAX_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.endsWith(".")
  );
}

function displayDestinationPath(
  destinationPath: string,
  suggestedName: string,
  worktreeName: string,
): string {
  if (!destinationPath.endsWith(suggestedName)) return destinationPath;
  return `${destinationPath.slice(0, -suggestedName.length)}${worktreeName || suggestedName}`;
}

async function openReviewTask(reviewLink: PullRequestReviewLink): Promise<void> {
  const workspace = useWorkspaceStore.getState();
  workspace.recordPullRequestLink(
    reviewLink.threadId,
    reviewLink.identity.number,
    reviewLink.pullRequestUrl,
    reviewLink.pullRequestState,
  );

  if (workspace.activeWorkspaceId !== reviewLink.workspaceId) {
    workspace.setActiveWorkspace(reviewLink.workspaceId, undefined, false);
  }
  await useWorkspaceStore.getState().loadThreads(reviewLink.workspaceId);
  await useWorkspaceStore.getState().loadWorktrees(reviewLink.workspaceId);
  const loadedWorkspace = useWorkspaceStore.getState();
  const linkedThread = loadedWorkspace.threads.find(
    (thread) =>
      thread.id === reviewLink.threadId && thread.workspace_id === reviewLink.workspaceId,
  );
  if (!linkedThread) {
    throw new Error(
      "Review task exists, but its thread could not be loaded. Retry to open it.",
    );
  }
  loadedWorkspace.setActiveThread(reviewLink.threadId);
  useOverviewStore.getState().requestOpen(reviewLink.threadId);
  useUiStore.getState().setPrimarySurface("chat");
}

function errorCopy(error: PullRequestError): string {
  if (error.code === "workspace_mapping_missing") {
    return "No project matches this repository. Add the repository as a project, then retry.";
  }
  if (error.code === "workspace_mapping_ambiguous") {
    return "More than one project matches this repository. Choose the project that should own the Review task.";
  }
  return error.message;
}

function SourceReadout({ source }: { source: PullRequestReviewSource }) {
  return (
    <div className="bg-page/65 px-5 py-4">
      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
        Change stack
      </p>
      <div className="mt-2 flex min-w-0 items-center gap-2 text-sm text-foreground/90">
        <GitPullRequest size={14} aria-hidden className="shrink-0 text-primary/85" />
        <span className="truncate font-medium">
          {source.identity.owner}/{source.identity.repository} #{source.identity.number}
        </span>
      </div>
      <p className="mt-1 truncate text-xs text-muted-foreground">{source.title}</p>
      <p className="mt-3 flex min-w-0 items-center gap-2 font-mono text-xs text-foreground/80">
        <span className="truncate">{source.base.name}</span>
        <span aria-hidden className="text-muted-foreground/45">←</span>
        <span className="truncate text-foreground">{source.head.name}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {source.expectedHeadOid.slice(0, 7)}
        </span>
      </p>
    </div>
  );
}

function IntentField({
  value,
  onChange,
  disabled,
  inputRef,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  invalid: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor="pull-request-review-intent" className="text-xs text-muted-foreground">
        Task intent
      </label>
      <Textarea
        ref={inputRef}
        id="pull-request-review-intent"
        value={value}
        maxLength={PULL_REQUEST_REVIEW_INTENT_MAX_LENGTH}
        rows={3}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        className="resize-none"
      />
      <p className="font-mono text-xs tabular-nums text-muted-foreground/70">
        {value.length}/{PULL_REQUEST_REVIEW_INTENT_MAX_LENGTH}
      </p>
    </div>
  );
}

function ExistingWorktreeReadout({
  worktree,
}: {
  worktree: PullRequestReviewWorktreeCandidate;
}) {
  return (
    <dl className="space-y-3 text-xs">
      <div>
        <dt className="font-mono uppercase tracking-wider text-muted-foreground">Worktree</dt>
        <dd className="mt-1 flex items-center gap-2 text-foreground/90">
          <GitBranch size={13} aria-hidden className="text-muted-foreground" />
          <span className="font-medium">{worktree.name}</span>
          <span className="font-mono text-muted-foreground">{worktree.branch}</span>
        </dd>
      </div>
      <div>
        <dt className="font-mono uppercase tracking-wider text-muted-foreground">Path</dt>
        <dd className="mt-1 break-all font-mono text-sm leading-5 text-foreground">
          {worktree.path}
        </dd>
      </div>
    </dl>
  );
}

interface ReviewTaskDialogBodyProps {
  phase: DialogPhase;
  busy: boolean;
  error: PullRequestError | null;
  prepared: PreparedReviewTask | null;
  candidates: PullRequestWorkspaceCandidate[];
  selectedWorkspaceId: string | null;
  selectedWorkspace: PullRequestWorkspaceCandidate | undefined;
  worktreeName: string;
  intent: string;
  worktreeNameInvalid: boolean;
  intentInvalid: boolean;
  nameInputRef: RefObject<HTMLInputElement | null>;
  intentInputRef: RefObject<HTMLTextAreaElement | null>;
  setSelectedWorkspaceId: (workspaceId: string | null) => void;
  setWorktreeName: (worktreeName: string) => void;
  setIntent: (intent: string) => void;
  onPrepare: (workspaceId?: string) => Promise<void>;
  onSubmit: () => Promise<void>;
  onClose: (open: boolean) => void;
}

function ReviewTaskDialogBody(props: ReviewTaskDialogBodyProps) {
  if (props.phase === "preparing" || props.phase === "navigating") {
    return <ReviewTaskPreparing phase={props.phase} />;
  }
  if (props.error && !props.prepared) {
    return <ReviewTaskPreparationError {...props} error={props.error} />;
  }
  return props.prepared ? <ReviewTaskPreparedContent {...props} prepared={props.prepared} /> : null;
}

function ReviewTaskPreparing({ phase }: { phase: DialogPhase }) {
  return (
    <div className="flex min-h-52 items-center justify-center gap-2 px-6 text-xs text-muted-foreground">
      <Spinner size="xs" aria-hidden />
      <span>{phase === "navigating" ? "Opening Review task" : "Checking local projects"}</span>
    </div>
  );
}

function ReviewTaskPreparationError({
  error,
  candidates,
  selectedWorkspaceId,
  selectedWorkspace,
  setSelectedWorkspaceId,
  onPrepare,
  onClose,
}: ReviewTaskDialogBodyProps & { error: PullRequestError }) {
  const ambiguous = error.code === "workspace_mapping_ambiguous" && candidates.length > 0;
  const missingProject = error.code === "workspace_mapping_missing";
  return (
    <div className="space-y-4 px-5 py-5">
      <div role="alert" className="flex items-start gap-2 bg-destructive/8 px-3 py-2.5 text-xs">
        <AlertCircle size={14} aria-hidden className="mt-0.5 shrink-0 text-destructive" />
        <p className="text-foreground/85">{errorCopy(error)}</p>
      </div>
      {ambiguous ? (
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground" htmlFor="review-task-workspace">Project</label>
          <Select value={selectedWorkspaceId} onValueChange={setSelectedWorkspaceId}>
            <SelectTrigger id="review-task-workspace" className="w-full">
              <SelectValue>{selectedWorkspace ? selectedWorkspace.name : "Choose a project"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {candidates.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  <span className="min-w-0">
                    <span className="block truncate">{candidate.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{candidate.path}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <DialogFooter className="m-0 -mx-5 -mb-5 flex-row justify-end rounded-none bg-transparent px-5 py-3.5">
        <Button variant="ghost" onClick={() => onClose(false)}>Cancel</Button>
        {missingProject ? (
          <Button onClick={() => openProjectPicker(onClose)}>Add project</Button>
        ) : ambiguous ? (
          <Button disabled={!selectedWorkspaceId} onClick={() => void onPrepare(selectedWorkspaceId ?? undefined)}>
            Use project
          </Button>
        ) : (
          <Button onClick={() => void onPrepare()}>Retry</Button>
        )}
      </DialogFooter>
    </div>
  );
}

function openProjectPicker(onClose: (open: boolean) => void): void {
  onClose(false);
  requestAnimationFrame(() => {
    useCommandPaletteStore.getState().open({ intent: "addProject" });
  });
}

function ReviewTaskPreparedContent({
  phase,
  busy,
  error,
  prepared,
  worktreeName,
  intent,
  worktreeNameInvalid,
  intentInvalid,
  nameInputRef,
  intentInputRef,
  setWorktreeName,
  setIntent,
  onPrepare,
  onSubmit,
  onClose,
}: ReviewTaskDialogBodyProps & { prepared: PreparedReviewTask }) {
  const confirmationRequired = prepared.status === "confirmation_required";
  const submitDisabled = busy || intentInvalid || worktreeNameInvalid;
  return (
    <>
      <SourceReadout source={prepared.source} />
      <div className="space-y-4 px-5 py-4">
        {error ? <ReviewTaskErrorNotice error={error} onRefresh={() => void onPrepare(prepared.workspace.id)} /> : null}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <MapPin size={13} aria-hidden />
          <span>Project</span>
          <span className="ml-auto truncate text-foreground/85">{prepared.workspace.name}</span>
        </div>
        {confirmationRequired ? (
          <ReviewTaskNewWorktreeFields
            prepared={prepared}
            worktreeName={worktreeName}
            invalid={worktreeNameInvalid}
            disabled={busy}
            inputRef={nameInputRef}
            onChange={setWorktreeName}
          />
        ) : (
          <ExistingWorktreeReadout worktree={prepared.worktree} />
        )}
        <IntentField value={intent} onChange={setIntent} disabled={busy} inputRef={intentInputRef} invalid={intentInvalid} />
        <p className="text-xs leading-5 text-muted-foreground">
          This changes local worktree and task state. Remote pull request actions stay explicit.
        </p>
      </div>
      <DialogFooter className="m-0 flex-row justify-end rounded-none bg-page/65 px-5 py-3.5">
        <Button variant="ghost" disabled={busy} onClick={() => onClose(false)}>Cancel</Button>
        <Button disabled={submitDisabled} onClick={() => void onSubmit()}>
          <ReviewTaskSubmitLabel phase={phase} confirmationRequired={confirmationRequired} />
        </Button>
      </DialogFooter>
    </>
  );
}

function ReviewTaskErrorNotice({ error, onRefresh }: { error: PullRequestError; onRefresh: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-2 bg-destructive/8 px-3 py-2.5 text-xs">
      <AlertCircle size={14} aria-hidden className="mt-0.5 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1 text-foreground/85">{errorCopy(error)}</p>
      <Button variant="ghost" size="xs" onClick={onRefresh}>Refresh</Button>
    </div>
  );
}

function ReviewTaskNewWorktreeFields({
  prepared,
  worktreeName,
  invalid,
  disabled,
  inputRef,
  onChange,
}: {
  prepared: Extract<PreparedReviewTask, { status: "confirmation_required" }>;
  worktreeName: string;
  invalid: boolean;
  disabled: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (worktreeName: string) => void;
}) {
  return (
    <>
      <div className="space-y-1.5">
        <label htmlFor="pull-request-worktree-name" className="text-xs text-muted-foreground">Worktree name</label>
        <Input
          ref={inputRef}
          id="pull-request-worktree-name"
          value={worktreeName}
          maxLength={PULL_REQUEST_REVIEW_WORKTREE_NAME_MAX_LENGTH}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.target.value)}
          className="font-mono"
        />
      </div>
      <div>
        <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Destination</p>
        <p className="mt-1 break-all font-mono text-sm leading-5 text-foreground">
          {displayDestinationPath(prepared.destinationPath, prepared.suggestedWorktreeName, worktreeName)}
        </p>
      </div>
    </>
  );
}

function ReviewTaskSubmitLabel({ phase, confirmationRequired }: { phase: DialogPhase; confirmationRequired: boolean }) {
  if (phase === "submitting") {
    return <><Spinner size="xs" aria-hidden />Creating task</>;
  }
  return confirmationRequired ? "Create Review task" : "Use existing worktree";
}

/** Props for the local Review-task preparation and confirmation dialog. */
export interface PullRequestReviewTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  identity: PullRequestIdentity;
  /** Head OID currently rendered in detail, used to invalidate stale proposals. */
  currentHeadOid: string | null;
  transport?: PullRequestReviewTaskTransport;
}

/** Prepare, confirm, and open a pull request Review task without a remote write. */
export function PullRequestReviewTaskDialog({
  open,
  onOpenChange,
  identity,
  currentHeadOid,
  transport,
}: PullRequestReviewTaskDialogProps) {
  const resolveTransport = useCallback(
    () => transport ?? getPullRequestReviewTaskTransport(),
    [transport],
  );
  const [phase, setPhase] = useState<DialogPhase>("idle");
  const [prepared, setPrepared] = useState<PreparedReviewTask | null>(null);
  const [error, setError] = useState<PullRequestError | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [worktreeName, setWorktreeName] = useState("");
  const [intent, setIntent] = useState("");
  const generationRef = useRef(0);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const intentInputRef = useRef<HTMLTextAreaElement>(null);
  const busy = phase === "preparing" || phase === "submitting" || phase === "navigating";
  const closeBlocked = phase === "submitting" || phase === "navigating";

  useEffect(() => {
    if (open && phase === "ready" && error?.code === "path_collision") {
      nameInputRef.current?.focus();
    }
  }, [error, open, phase]);

  const finishReady = useCallback(
    async (
      result: Extract<PullRequestCreateReviewTaskResult, { ok: true; status: "ready" }>,
      generation: number,
    ) => {
      setPhase("navigating");
      try {
        await openReviewTask(result.reviewLink);
      } catch (caught) {
        if (generationRef.current !== generation) return;
        setPrepared(null);
        setError({
          code: "remote_unavailable",
          message:
            caught instanceof Error
              ? caught.message.slice(0, 512)
              : "Review task exists, but its thread could not be loaded.",
        });
        setPhase("ready");
        return;
      }
      if (generationRef.current !== generation) return;
      if (result.warnings?.length) {
        useToastStore.getState().show(
          "info",
          "Review task created",
          result.warnings.join(" "),
          8_000,
        );
      }
      onOpenChange(false);
    },
    [onOpenChange],
  );

  const prepare = useCallback(
    async (workspaceId?: string) => {
      const generation = ++generationRef.current;
      setPhase("preparing");
      setPrepared(null);
      setError(null);
      try {
        const result = await prepareReviewTaskRequest(
          resolveTransport(),
          identity,
          workspaceId,
        );
        if (generationRef.current !== generation) return;
        if (!result.ok) {
          setError(result.error);
          setSelectedWorkspaceId(result.error.workspaceCandidates?.[0]?.id ?? null);
          setPhase("ready");
          return;
        }
        if (result.status === "ready") {
          await finishReady(result, generation);
          return;
        }
        setPrepared(result);
        setIntent(defaultIntent());
        setWorktreeName(
          result.status === "confirmation_required" ? result.suggestedWorktreeName : "",
        );
        setPhase("ready");
      } catch (caught) {
        if (generationRef.current !== generation) return;
        setError(reviewTaskError(caught, "Review task preparation failed."));
        setPhase("ready");
      }
    },
    [finishReady, identity, resolveTransport],
  );

  useEffect(() => {
    if (!open) {
      generationRef.current += 1;
      return;
    }
    setSelectedWorkspaceId(null);
    setWorktreeName("");
    setIntent("");
    void prepare();
  }, [open, prepare]);

  useEffect(() => {
    if (!open || !prepared || currentHeadOid === prepared.source.expectedHeadOid) return;
    if (!currentHeadOid) {
      generationRef.current += 1;
      onOpenChange(false);
      return;
    }
    void prepare(prepared.workspace.id);
  }, [currentHeadOid, onOpenChange, open, prepare, prepared]);

  const handleCreationResult = useCallback(
    async (
      result: PullRequestCreateReviewTaskResult,
      generation: number,
    ): Promise<void> => {
      if (generationRef.current !== generation) return;
      if (!result.ok) {
        setError(result.error);
        setPhase("ready");
        return;
      }
      if (result.status === "ready") {
        await finishReady(result, generation);
        return;
      }
      setPrepared(result);
      if (result.status === "confirmation_required") {
        setWorktreeName(result.suggestedWorktreeName);
      }
      setPhase("ready");
    },
    [finishReady],
  );

  const submit = useCallback(async () => {
    if (!prepared || busy) return;
    const trimmedIntent = intent.trim();
    if (!trimmedIntent) {
      intentInputRef.current?.focus();
      return;
    }
    if (prepared.status === "confirmation_required" && !isValidWorktreeName(worktreeName)) {
      nameInputRef.current?.focus();
      return;
    }

    const generation = ++generationRef.current;
    setPhase("submitting");
    setError(null);
    try {
      const result = await resolveTransport().createReviewTask(
        createReviewTaskRequest(prepared, identity, worktreeName, trimmedIntent),
      );
      await handleCreationResult(result, generation);
    } catch (caught) {
      if (generationRef.current !== generation) return;
      setError(reviewTaskError(caught, "Review task creation failed."));
      setPhase("ready");
    }
  }, [busy, handleCreationResult, identity, intent, prepared, resolveTransport, worktreeName]);

  const close = useCallback(
    (nextOpen: boolean) => {
      if (closeBlocked) return;
      if (!nextOpen) generationRef.current += 1;
      onOpenChange(nextOpen);
    },
    [closeBlocked, onOpenChange],
  );

  const candidates = error?.workspaceCandidates ?? [];
  const selectedWorkspace = candidates.find((candidate) => candidate.id === selectedWorkspaceId);
  const worktreeNameInvalid =
    prepared?.status === "confirmation_required" && !isValidWorktreeName(worktreeName);
  const intentInvalid = intent.trim().length === 0;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="w-[min(94vw,560px)] gap-0 overflow-hidden p-0 sm:max-w-[560px]"
        showCloseButton={!closeBlocked}
      >
        <header className="flex items-start gap-3 bg-page px-5 py-4 pr-12">
          <GitPullRequest size={18} aria-hidden className="mt-0.5 shrink-0 text-primary/85" />
          <div className="min-w-0">
            <DialogTitle className="text-sm">Review Change Stack</DialogTitle>
            <DialogDescription className="mt-1 text-xs leading-5">
              Create a local Review worktree and task from the pull request head.
            </DialogDescription>
          </div>
        </header>
        <ReviewTaskDialogBody
          phase={phase}
          busy={busy}
          error={error}
          prepared={prepared}
          candidates={candidates}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedWorkspace={selectedWorkspace}
          worktreeName={worktreeName}
          intent={intent}
          worktreeNameInvalid={Boolean(worktreeNameInvalid)}
          intentInvalid={intentInvalid}
          nameInputRef={nameInputRef}
          intentInputRef={intentInputRef}
          setSelectedWorkspaceId={setSelectedWorkspaceId}
          setWorktreeName={setWorktreeName}
          setIntent={setIntent}
          onPrepare={prepare}
          onSubmit={submit}
          onClose={close}
        />
      </DialogContent>
    </Dialog>
  );
}
