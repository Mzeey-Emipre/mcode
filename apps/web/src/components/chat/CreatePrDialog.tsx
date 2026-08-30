import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from "react";
import { GitPullRequest, GitBranch, ChevronDown, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from "@/components/ui/command";
import { Switch } from "@/components/ui/switch";
import { SegControl } from "@/components/settings/SegControl";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useToastStore } from "@/stores/toastStore";
import type { GitBranch as GitBranchType } from "@mcode/contracts";

const PreviewMarkdown = lazy(() => import("./MarkdownContent"));

// ---------------------------------------------------------------------------
// BaseBranchSelect — searchable local-branch picker for the PR dialog sidebar
// ---------------------------------------------------------------------------

interface BaseBranchSelectProps {
  branches: GitBranchType[];
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
}

/**
 * Searchable dropdown for picking the PR base branch.
 * Uses Popover + Command for native keyboard navigation (arrow keys, Enter, Escape).
 */
function BaseBranchSelect({ branches, value, onChange, disabled }: BaseBranchSelectProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            aria-label="Base branch"
            className={cn(
              "flex h-8 w-full items-center justify-between rounded-lg border border-input bg-background pl-3 pr-2.5 text-sm shadow-xs transition-colors",
              "focus-visible:border-ring focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
              open && "border-ring",
            )}
          >
            <span className="truncate">{value}</span>
            <ChevronDown
              className={cn("size-3.5 text-muted-foreground transition-transform duration-150", open && "rotate-180")}
              aria-hidden="true"
            />
          </button>
        }
      />
      <PopoverContent align="start" sideOffset={4} className="min-w-[200px] p-0">
        <Command filter={(v, search) => (v.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}>
          <CommandInput placeholder="Search branches…" />
          <CommandList className="max-h-[200px]">
            <CommandEmpty>No branches match</CommandEmpty>
            {branches.map((b) => (
              <CommandItem
                key={b.name}
                value={b.name}
                onSelect={(name) => { onChange(name); setOpen(false); }}
                className={cn(
                  "flex justify-between text-xs",
                  b.name === value && "bg-accent text-foreground",
                )}
              >
                <span className="truncate">{b.name}</span>
                {b.isCurrent && (
                  <Badge variant="secondary" size="sm" className="ml-2 shrink-0">current</Badge>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Possible states for the PR creation flow. */
type DialogState = "loading" | "ready" | "submitting" | "error";
type DescriptionMode = "write" | "preview";

interface PrDialogForm {
  state: DialogState;
  setState: (state: DialogState) => void;
  error: string | null;
  setError: (error: string | null) => void;
  isRegenerating: boolean;
  setIsRegenerating: (isRegenerating: boolean) => void;
  title: string;
  setTitle: (title: string) => void;
  body: string;
  setBody: (body: string) => void;
  isDraft: boolean;
  setIsDraft: (isDraft: boolean) => void;
  descMode: DescriptionMode;
  setDescMode: (descMode: DescriptionMode) => void;
}

interface BaseBranchSelection {
  baseBranches: GitBranchType[];
  baseBranch: string;
  setBaseBranch: (branch: string) => void;
  hasValidBase: boolean;
}

interface PrDialogHeaderProps {
  branch: string;
  baseBranch: string;
  isDraft: boolean;
}

interface PrDialogSidebarProps {
  form: PrDialogForm;
  baseBranchSelection: BaseBranchSelection;
  isDisabled: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}

interface PrDescriptionPanelProps {
  form: PrDialogForm;
  isDisabled: boolean;
  onRegenerate: () => void;
}

/** Props for the CreatePrDialog component. */
export interface CreatePrDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Callback to open or close the dialog. */
  onOpenChange: (open: boolean) => void;
  /** ID of the thread to create the PR from. */
  threadId: string;
  /** ID of the workspace that owns the thread. */
  workspaceId: string;
  /** Current branch name, shown in the form description. */
  branch: string;
  /** Preferred base branch selected before this dialog opens. */
  preferredBaseBranch?: string | null;
}

function usePrDialogForm(): PrDialogForm {
  const [state, setState] = useState<DialogState>("ready");
  const [error, setError] = useState<string | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isDraft, setIsDraft] = useState(false);
  const [descMode, setDescMode] = useState<DescriptionMode>("write");

  return {
    state,
    setState,
    error,
    setError,
    isRegenerating,
    setIsRegenerating,
    title,
    setTitle,
    body,
    setBody,
    isDraft,
    setIsDraft,
    descMode,
    setDescMode,
  };
}

function getBaseBranches(branches: GitBranchType[], branch: string): GitBranchType[] {
  const seen = new Set<string>();
  const baseBranches: GitBranchType[] = [];

  for (const candidate of branches) {
    if (candidate.type === "worktree") continue;

    const name = candidate.type === "remote" ? candidate.name.replace(/^[^/]+\//, "") : candidate.name;
    if (name === branch || seen.has(name)) continue;

    seen.add(name);
    baseBranches.push({ ...candidate, name });
  }

  return baseBranches;
}

function getDefaultBaseBranch(baseBranches: GitBranchType[], preferredBaseBranch?: string | null): string {
  return (
    baseBranches.find((candidate) => candidate.name === preferredBaseBranch) ??
    baseBranches.find((candidate) => candidate.name === "main") ??
    baseBranches.find((candidate) => candidate.name === "master") ??
    baseBranches[0]
  )?.name ?? "";
}

function useBaseBranchSelection(
  open: boolean,
  branches: GitBranchType[],
  threadId: string,
  branch: string,
  preferredBaseBranch?: string | null,
): BaseBranchSelection {
  const baseBranches = useMemo(() => getBaseBranches(branches, branch), [branches, branch]);
  const defaultBaseBranch = getDefaultBaseBranch(baseBranches, preferredBaseBranch);
  const [baseBranch, setBaseBranch] = useState(defaultBaseBranch);
  const baseInitializationKey = `${threadId}:${branch}:${preferredBaseBranch ?? ""}`;
  const initializedBaseKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      initializedBaseKeyRef.current = null;
      return;
    }
    if (!defaultBaseBranch) return;

    if (initializedBaseKeyRef.current !== baseInitializationKey) {
      initializedBaseKeyRef.current = baseInitializationKey;
      setBaseBranch(defaultBaseBranch);
      return;
    }
    if (!baseBranches.some((candidate) => candidate.name === baseBranch)) {
      setBaseBranch(defaultBaseBranch);
    }
  }, [baseBranches, baseBranch, baseInitializationKey, defaultBaseBranch, open]);

  return {
    baseBranches,
    baseBranch,
    setBaseBranch,
    hasValidBase: baseBranches.some((candidate) => candidate.name === baseBranch),
  };
}

function isDialogDisabled(
  state: DialogState,
  branchesLoading: boolean,
  hasValidBase: boolean,
  isRegenerating: boolean,
): boolean {
  return state === "loading" || state === "submitting" || branchesLoading || !hasValidBase || isRegenerating;
}

function shouldAutoGenerateDraft(
  open: boolean,
  hasValidBase: boolean,
  branchesLoading: boolean,
  title: string,
  body: string,
  isRegenerating: boolean,
  wasAutoGenerated: boolean,
): boolean {
  return open && hasValidBase && !branchesLoading && !title.trim() && !body.trim() && !isRegenerating && !wasAutoGenerated;
}

/**
 * Modal dialog for creating a GitHub pull request from a thread.
 * Generates an AI-powered PR draft on open, then allows the user to
 * edit the title and body before submitting.
 */
export function CreatePrDialog({
  open,
  onOpenChange,
  threadId,
  workspaceId,
  branch,
  preferredBaseBranch,
}: CreatePrDialogProps) {
  const branches = useWorkspaceStore((s) => s.branches);
  const branchesLoading = useWorkspaceStore((s) => s.branchesLoading);
  const loadBranches = useWorkspaceStore((s) => s.loadBranches);

  const form = usePrDialogForm();
  const baseBranchSelection = useBaseBranchSelection(
    open,
    branches,
    threadId,
    branch,
    preferredBaseBranch,
  );
  const autoGeneratedSessionKeyRef = useRef<string | null>(null);
  const baseInitializationKey = `${threadId}:${branch}:${preferredBaseBranch ?? ""}`;

  // Load branches when the dialog opens.
  useEffect(() => {
    if (open && workspaceId) {
      loadBranches(workspaceId);
    }
  }, [open, workspaceId, loadBranches]);

  // Reset ephemeral fields when the dialog closes — but not during an in-flight
  // submission, since the close could be a forced unmount while createPr() is pending.
  useEffect(() => {
    if (!open && form.state !== "submitting") {
      form.setTitle("");
      form.setBody("");
      form.setIsDraft(false);
      form.setError(null);
      form.setDescMode("write");
      form.setState("ready");
      autoGeneratedSessionKeyRef.current = null;
    }
  }, [open, form.state]);

  // Keep a stable ref to onOpenChange so useCallback closures don't go stale.
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; }, [onOpenChange]);

  /** Intercept close requests — block them while a submission or draft generation is in flight. */
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && (form.state === "submitting" || form.isRegenerating)) return;
    onOpenChangeRef.current(nextOpen);
  }, [form.isRegenerating, form.state]);

  const handleSubmit = useCallback(async () => {
    if (!baseBranchSelection.hasValidBase) return;
    form.setState("submitting");
    form.setError(null);
    try {
      const result = await getTransport().createPr(
        workspaceId,
        threadId,
        form.title,
        form.body,
        baseBranchSelection.baseBranch,
        form.isDraft,
      );
      useWorkspaceStore.getState().recordPrCreated(threadId, result.number, result.url);
      // Transition to ready before closing so the reset effect can clear the form.
      form.setState("ready");
      onOpenChange(false);
      useToastStore.getState().show("info", "Pull request created", `PR #${result.number} opened on GitHub`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "PR creation failed";
      form.setError(message);
      form.setState("ready");
    }
  }, [workspaceId, threadId, onOpenChange, baseBranchSelection, form]);

  /** Re-run AI draft generation with the current base branch, keeping existing content visible. */
  const handleRegenerate = useCallback(async () => {
    if (!baseBranchSelection.hasValidBase) return;
    form.setIsRegenerating(true);
    form.setError(null);
    try {
      const draft = await getTransport().generatePrDraft(workspaceId, threadId, baseBranchSelection.baseBranch);
      form.setTitle(draft.title);
      form.setBody(draft.body);
    } catch (err) {
      form.setError(`Draft generation failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      form.setIsRegenerating(false);
    }
  }, [workspaceId, threadId, baseBranchSelection, form]);

  const autoGenerateSessionKey = `${threadId}:${branch}:${baseInitializationKey}`;

  // Generate an initial draft once per open when the form is still empty.
  useEffect(() => {
    const wasAutoGenerated = autoGeneratedSessionKeyRef.current === autoGenerateSessionKey;
    if (!shouldAutoGenerateDraft(
      open,
      baseBranchSelection.hasValidBase,
      branchesLoading,
      form.title,
      form.body,
      form.isRegenerating,
      wasAutoGenerated,
    )) return;

    autoGeneratedSessionKeyRef.current = autoGenerateSessionKey;
    void handleRegenerate();
  }, [
    open,
    baseBranchSelection.hasValidBase,
    branchesLoading,
    form.title,
    form.body,
    form.isRegenerating,
    autoGenerateSessionKey,
    handleRegenerate,
  ]);

  const isDisabled = isDialogDisabled(
    form.state,
    branchesLoading,
    baseBranchSelection.hasValidBase,
    form.isRegenerating,
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-4xl w-[min(90vw,900px)] gap-0 overflow-hidden p-0"
        showCloseButton={!isDisabled}
      >
        <PrDialogHeader
          branch={branch}
          baseBranch={baseBranchSelection.baseBranch}
          isDraft={form.isDraft}
        />

        <div className="flex min-h-[320px] max-h-[min(480px,70vh)] max-sm:max-h-[min(640px,85vh)] max-sm:flex-col">
          <PrDialogSidebar
            form={form}
            baseBranchSelection={baseBranchSelection}
            isDisabled={isDisabled}
            onSubmit={handleSubmit}
            onCancel={() => onOpenChange(false)}
          />

          <PrDescriptionPanel
            form={form}
            isDisabled={isDisabled}
            onRegenerate={handleRegenerate}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PrDialogHeader({ branch, baseBranch, isDraft }: PrDialogHeaderProps) {
  return (
    <div className="flex items-center gap-3 border-b border-border/50 py-4 pl-5 pr-12">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
        <GitPullRequest className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <DialogTitle className="text-sm font-medium leading-none">Create pull request</DialogTitle>
        <DialogDescription className="mt-1 flex min-w-0 items-center gap-1.5 text-xs">
          <span className="min-w-0 max-w-[min(200px,40vw)] truncate font-mono text-foreground/80">
            {branch}
          </span>
          <span className="shrink-0 text-muted-foreground/50" aria-hidden="true">→</span>
          <span className="min-w-0 max-w-[min(200px,40vw)] truncate font-mono text-muted-foreground">
            {baseBranch}
          </span>
        </DialogDescription>
      </div>
      {isDraft && (
        <span className="shrink-0 rounded border border-border/50 bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
          Draft
        </span>
      )}
    </div>
  );
}

function PrDialogSidebar({
  form,
  baseBranchSelection,
  isDisabled,
  onSubmit,
  onCancel,
}: PrDialogSidebarProps) {
  return (
    <div className="flex min-h-0 w-64 shrink-0 flex-col gap-4 border-r border-border/50 p-5 max-sm:w-full max-sm:border-r-0 max-sm:border-b max-sm:border-border/50">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="pr-title" className="text-xs text-muted-foreground">
          Title
        </label>
        <Input
          id="pr-title"
          value={form.title}
          onChange={(event) => form.setTitle(event.target.value)}
          placeholder="PR title"
          disabled={isDisabled}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <GitBranch className="size-3" aria-hidden="true" />
          Base branch
        </label>
        <BaseBranchSelect
          branches={baseBranchSelection.baseBranches}
          value={baseBranchSelection.baseBranch}
          onChange={baseBranchSelection.setBaseBranch}
          disabled={isDisabled}
        />
      </div>

      <div className="flex items-center justify-between">
        <label
          htmlFor="pr-is-draft"
          className="cursor-pointer select-none text-xs text-muted-foreground"
        >
          Draft PR
        </label>
        <Switch
          id="pr-is-draft"
          checked={form.isDraft}
          onCheckedChange={form.setIsDraft}
          disabled={isDisabled}
        />
      </div>

      <div className="flex-1" />

      {form.error && (
        <div
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {form.error}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Button
          onClick={onSubmit}
          disabled={isDisabled || !form.title.trim()}
          className="w-full gap-1.5"
        >
          {form.state === "submitting" && <Spinner size={14} className="text-current" />}
          Create PR
        </Button>
        <Button
          variant="ghost"
          onClick={onCancel}
          disabled={isDisabled}
          className="w-full"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PrDescriptionPanel({ form, isDisabled, onRegenerate }: PrDescriptionPanelProps) {
  if (form.isRegenerating && !form.body) {
    return <PrDraftLoadingState />;
  }

  return (
    <PrDescriptionEditor
      form={form}
      isDisabled={isDisabled}
      onRegenerate={onRegenerate}
    />
  );
}

function PrDraftLoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <Spinner size={16} className="text-muted-foreground" />
      Generating PR draft…
    </div>
  );
}

function PrDescriptionEditor({ form, isDisabled, onRegenerate }: PrDescriptionPanelProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-5">
      <div className="flex items-center justify-between">
        <label htmlFor="pr-body" className="text-xs text-muted-foreground">
          Description
        </label>
        <div className="flex items-center gap-2">
          <PrDraftGenerationButton
            isRegenerating={form.isRegenerating}
            hasDraftContent={Boolean(form.title || form.body)}
            disabled={isDisabled}
            onRegenerate={onRegenerate}
          />
          <SegControl
            options={[
              { value: "write", label: "Write" },
              { value: "preview", label: "Preview" },
            ]}
            value={form.descMode}
            onChange={(mode) => form.setDescMode(mode as DescriptionMode)}
          />
        </div>
      </div>
      <PrDescriptionField form={form} isDisabled={isDisabled} />
    </div>
  );
}

function PrDraftGenerationButton({
  isRegenerating,
  hasDraftContent,
  disabled,
  onRegenerate,
}: {
  isRegenerating: boolean;
  hasDraftContent: boolean;
  disabled: boolean;
  onRegenerate: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onRegenerate}
      disabled={disabled}
      className="h-6 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
    >
      {isRegenerating ? (
        <Spinner size={12} className="text-current" />
      ) : (
        <RefreshCw className="size-3" aria-hidden="true" />
      )}
      {hasDraftContent ? "Regenerate" : "Generate"}
    </Button>
  );
}

function PrDescriptionField({ form, isDisabled }: Pick<PrDescriptionPanelProps, "form" | "isDisabled">) {
  if (form.descMode === "write") {
    return (
      <textarea
        id="pr-body"
        value={form.body}
        onChange={(event) => form.setBody(event.target.value)}
        disabled={isDisabled}
        placeholder="PR description"
        className={cn(
          "flex-1 min-h-0 w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm shadow-xs transition-colors",
          "font-mono resize-none overflow-y-auto",
          "placeholder:text-muted-foreground",
          "focus-visible:border-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      />
    );
  }

  return <PrMarkdownPreview body={form.body} />;
}

function PrMarkdownPreview({ body }: { body: string }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-input bg-background px-3 py-2.5 text-sm">
      {body.trim() ? (
        <Suspense fallback={<span className="text-sm text-muted-foreground">Loading preview…</span>}>
          <PreviewMarkdown content={body} />
        </Suspense>
      ) : (
        <span className="italic text-muted-foreground">Nothing to preview.</span>
      )}
    </div>
  );
}
