import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import type {
  WorkspaceEnvironmentAction,
  WorkspaceEnvironmentCommand,
  WorkspaceEnvironmentDocument,
  WorkspaceEnvironmentReadResult,
  WorkspaceEnvironmentStorageMode,
} from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { getTransport, RpcError } from "@/transport";
import { useProjectActionStore } from "./state/project-action-store";

const PLATFORMS = [
  ["default", "Default"],
  ["macos", "macOS"],
  ["linux", "Linux"],
  ["windows", "Windows"],
] as const;

type Platform = (typeof PLATFORMS)[number][0];

const EMPTY_DOCUMENT: WorkspaceEnvironmentDocument = {
  version: "0.0.1",
  actions: [],
};

function updateCommand(command: WorkspaceEnvironmentCommand, platform: Platform, script: string): WorkspaceEnvironmentCommand {
  const next = { ...command };
  if (script.length === 0) delete next[platform];
  else next[platform] = script;
  return next;
}

function newAction(): WorkspaceEnvironmentAction {
  return {
    id: crypto.randomUUID(),
    name: "New action",
    command: { default: "" },
  };
}

interface PlatformCommandEditorProps {
  readonly idPrefix: string;
  readonly command: WorkspaceEnvironmentCommand;
  readonly onChange: (command: WorkspaceEnvironmentCommand) => void;
  readonly firstControlRef?: RefObject<HTMLTextAreaElement | null>;
}

/** Renders a terminal-style command editor with manual, roving platform tabs. */
function PlatformCommandEditor({ idPrefix, command, onChange, firstControlRef }: PlatformCommandEditorProps) {
  const [platform, setPlatform] = useState<Platform>("default");
  const tabRefs = useRef<Partial<Record<Platform, HTMLButtonElement | null>>>({});
  const tabIndex = PLATFORMS.findIndex(([key]) => key === platform);
  const focusPlatform = (next: Platform) => {
    setPlatform(next);
    tabRefs.current[next]?.focus();
  };
  const movePlatform = (delta: -1 | 1) => {
    const next = (tabIndex + delta + PLATFORMS.length) % PLATFORMS.length;
    focusPlatform(PLATFORMS[next][0]);
  };
  const tabId = `${idPrefix}-tab-${platform}`;
  const panelId = `${idPrefix}-panel-${platform}`;
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Command platform" className="flex flex-wrap gap-1 pb-1">
        {PLATFORMS.map(([key, label]) => (
          <Button
            key={key}
            ref={(node) => { tabRefs.current[key] = node; }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${key}`}
            aria-selected={platform === key}
            aria-controls={`${idPrefix}-panel-${key}`}
            tabIndex={platform === key ? 0 : -1}
            variant={platform === key ? "secondary" : "ghost"}
            size="sm"
            className="motion-reduce:transition-none"
            onClick={() => setPlatform(key)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); movePlatform(1); }
              else if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); movePlatform(-1); }
              else if (event.key === "Home") { event.preventDefault(); event.stopPropagation(); focusPlatform("default"); }
              else if (event.key === "End") { event.preventDefault(); event.stopPropagation(); focusPlatform("windows"); }
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId} tabIndex={0} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <Textarea
          ref={platform === "default" ? firstControlRef : undefined}
          id={`${idPrefix}-script-${platform}`}
          aria-label={`${PLATFORMS[tabIndex][1]} command script`}
          value={command[platform] ?? ""}
          onChange={(event) => onChange(updateCommand(command, platform, event.target.value))}
          className="h-36 min-h-36 w-full resize-none font-mono text-xs"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function issueText(error: unknown): string[] {
  if (error instanceof RpcError && error.data && Array.isArray(error.data.issues)) {
    return error.data.issues.map((candidate) => {
      if (!candidate || typeof candidate !== "object") return "Environment validation failed";
      const item = candidate as { path?: unknown; reason?: unknown; message?: unknown };
      const path = Array.isArray(item.path) ? item.path.join(".") : "document";
      const reason = typeof item.reason === "string" ? item.reason : "invalid_value";
      return `${path || "document"} (${reason}): ${typeof item.message === "string" ? item.message : "Invalid value"}`;
    });
  }
  return [error instanceof Error ? error.message : "Environment request failed"];
}

interface ActionEditorProps {
  readonly action: WorkspaceEnvironmentAction;
  readonly onChange: (action: WorkspaceEnvironmentAction) => void;
  readonly onRemove: () => void;
  readonly nameRef?: RefObject<HTMLInputElement | null>;
}

/** Renders one named action editor while preserving its stable id. */
function ActionEditor({ action, onChange, onRemove, nameRef }: ActionEditorProps) {
  return (
    <section className="space-y-4" aria-labelledby={`${action.id}-heading`}>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <label htmlFor={`${action.id}-name`} className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
          <Input
            ref={nameRef}
            id={`${action.id}-name`}
            aria-label={`Action name for ${action.name}`}
            value={action.name}
            onChange={(event) => onChange({ ...action, name: event.target.value })}
          />
        </div>
        <div className="flex items-end">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove action ${action.name}`} onClick={onRemove}>
            <Trash2 size={15} aria-hidden />
          </Button>
        </div>
      </div>
      <h3 id={`${action.id}-heading`} className="sr-only">{action.name} command</h3>
      <PlatformCommandEditor
        idPrefix={`action-${action.id}`}
        command={action.command}
        onChange={(command) => onChange({ ...action, command })}
      />
    </section>
  );
}

interface EnvironmentPersistenceOptions {
  workspaceId: string;
  threadId: string | undefined;
  scopeId: string;
  revision: string | null;
  draftRef: RefObject<WorkspaceEnvironmentDocument>;
  applyRead: (result: WorkspaceEnvironmentReadResult) => void;
  setRevision: Dispatch<SetStateAction<string | null>>;
  setLoadedScopeId: Dispatch<SetStateAction<string | null>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setSaving: Dispatch<SetStateAction<boolean>>;
  setStatus: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string[] | null>>;
  setConfirmSharedStorage: Dispatch<SetStateAction<boolean>>;
  firstTaskRef: RefObject<HTMLButtonElement | null>;
}

function useEnvironmentPersistence({
  workspaceId,
  threadId,
  scopeId,
  revision,
  draftRef,
  applyRead,
  setRevision,
  setLoadedScopeId,
  setLoading,
  setSaving,
  setStatus,
  setError,
  setConfirmSharedStorage,
  firstTaskRef,
}: EnvironmentPersistenceOptions) {
  const reload = useCallback(async (announce = false) => {
    setLoading(true);
    setStatus(null);
    try {
      const result = threadId
        ? await getTransport().readWorkspaceEnvironment(workspaceId, threadId)
        : await getTransport().readWorkspaceEnvironment(workspaceId);
      applyRead(result);
      if (announce) setStatus("Environment reloaded");
    } catch (nextError) {
      setError(issueText(nextError));
    } finally {
      setLoading(false);
    }
  }, [applyRead, setError, setLoading, setStatus, threadId, workspaceId]);
  const save = useCallback(async () => {
    const submittedDraft = draftRef.current;
    const submittedDraftJson = JSON.stringify(submittedDraft);
    setSaving(true);
    setStatus(null);
    try {
      const result = threadId
        ? await getTransport().saveWorkspaceEnvironment(workspaceId, submittedDraft, revision, threadId)
        : await getTransport().saveWorkspaceEnvironment(workspaceId, submittedDraft, revision);
      setRevision(result.revision);
      setLoadedScopeId(scopeId);
      if (JSON.stringify(draftRef.current) === submittedDraftJson) applyRead(result);
      useProjectActionStore.getState().invalidateWorkspaceConfiguration(workspaceId);
      setStatus("Environment saved");
      requestAnimationFrame(() => firstTaskRef.current?.focus());
    } catch (nextError) {
      setError(issueText(nextError));
    } finally {
      setSaving(false);
    }
  }, [applyRead, draftRef, firstTaskRef, revision, scopeId, setError, setLoadedScopeId, setRevision, setSaving, setStatus, threadId, workspaceId]);
  const changeStorageMode = useCallback(async (nextStorageMode: WorkspaceEnvironmentStorageMode) => {
    setSaving(true);
    setStatus(null);
    try {
      const result = threadId
        ? await getTransport().setWorkspaceEnvironmentStorageMode(workspaceId, nextStorageMode, threadId)
        : await getTransport().setWorkspaceEnvironmentStorageMode(workspaceId, nextStorageMode);
      applyRead(result);
      useProjectActionStore.getState().invalidateWorkspaceConfiguration(workspaceId);
      setStatus(nextStorageMode === "shared" ? "Shared environment enabled" : "System environment enabled");
    } catch (nextError) {
      setError(issueText(nextError));
    } finally {
      setSaving(false);
      setConfirmSharedStorage(false);
    }
  }, [applyRead, setConfirmSharedStorage, setError, setSaving, setStatus, threadId, workspaceId]);
  const clearApprovals = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    try {
      await getTransport().clearWorkspaceEnvironmentApprovals(workspaceId);
      setStatus("Shared command approvals cleared");
    } catch (nextError) {
      setError(issueText(nextError));
    } finally {
      setSaving(false);
    }
  }, [setError, setSaving, setStatus, workspaceId]);
  return { reload, save, changeStorageMode, clearApprovals };
}

function useEnvironmentDraftActions(
  setDraft: Dispatch<SetStateAction<WorkspaceEnvironmentDocument>>,
  setSetupEnabled: Dispatch<SetStateAction<boolean>>,
  setupScriptRef: RefObject<HTMLTextAreaElement | null>,
  firstTaskRef: RefObject<HTMLButtonElement | null>,
  firstActionNameRef: RefObject<HTMLInputElement | null>,
) {
  const setSetup = useCallback((enabled: boolean) => {
    setSetupEnabled(enabled);
    setDraft((current) => ({ ...current, setup: enabled ? current.setup ?? { default: "" } : undefined }));
    requestAnimationFrame(() => {
      if (enabled) setupScriptRef.current?.focus();
      else firstTaskRef.current?.focus();
    });
  }, [firstTaskRef, setDraft, setSetupEnabled, setupScriptRef]);
  const addAction = useCallback(() => {
    const action = newAction();
    setDraft((current) => ({ ...current, actions: [...current.actions, action] }));
    requestAnimationFrame(() => firstActionNameRef.current?.focus());
  }, [firstActionNameRef, setDraft]);
  const updateAction = useCallback((id: string, action: WorkspaceEnvironmentAction) => {
    setDraft((current) => ({ ...current, actions: current.actions.map((candidate) => candidate.id === id ? action : candidate) }));
  }, [setDraft]);
  const removeAction = useCallback((id: string) => {
    setDraft((current) => ({ ...current, actions: current.actions.filter((candidate) => candidate.id !== id) }));
    requestAnimationFrame(() => firstTaskRef.current?.focus());
  }, [firstTaskRef, setDraft]);
  return { setSetup, addAction, updateAction, removeAction };
}

function EnvironmentStorageSection({
  storageMode,
  saving,
  systemStorageDescriptionId,
  sharedStorageDescriptionId,
  onChangeStorageMode,
  onConfirmSharedStorage,
  onClearApprovals,
}: {
  storageMode: WorkspaceEnvironmentStorageMode;
  saving: boolean;
  systemStorageDescriptionId: string;
  sharedStorageDescriptionId: string;
  onChangeStorageMode: (mode: WorkspaceEnvironmentStorageMode) => Promise<void>;
  onConfirmSharedStorage: Dispatch<SetStateAction<boolean>>;
  onClearApprovals: () => Promise<void>;
}) {
  return (
    <section aria-labelledby="project-environment-storage-title" className="space-y-3">
      <div className="space-y-1">
        <h2 id="project-environment-storage-title" className="text-sm font-semibold">Environment storage</h2>
        <p className="text-xs text-muted-foreground">Choose where Mcode saves this Project’s Setup and actions.</p>
      </div>
      <div role="radiogroup" aria-label="Environment storage" className="mt-3 grid gap-2">
        <EnvironmentStorageOption
          mode="system"
          storageMode={storageMode}
          descriptionId={systemStorageDescriptionId}
          description="Only available on this computer."
          disabled={saving}
          onClick={() => { if (storageMode !== "system") void onChangeStorageMode("system"); }}
        />
        <EnvironmentStorageOption
          mode="shared"
          storageMode={storageMode}
          descriptionId={sharedStorageDescriptionId}
          description="Save in .mcode/environment.json for this Project."
          disabled={saving}
          onClick={() => { if (storageMode !== "shared") onConfirmSharedStorage(true); }}
        />
        <ClearSharedApprovals storageMode={storageMode} saving={saving} onClearApprovals={onClearApprovals} />
      </div>
    </section>
  );
}

function EnvironmentStorageOption({
  mode,
  storageMode,
  descriptionId,
  description,
  disabled,
  onClick,
}: {
  mode: WorkspaceEnvironmentStorageMode;
  storageMode: WorkspaceEnvironmentStorageMode;
  descriptionId: string;
  description: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const selected = storageMode === mode;
  const label = mode === "system" ? "System storage" : "Shared storage";
  return (
    <Button type="button" role="radio" aria-checked={selected} aria-label={label} aria-describedby={descriptionId} variant={selected ? "secondary" : "outline"} disabled={disabled} className="h-auto justify-start px-3 py-3 text-left" onClick={onClick}>
      <span className="flex min-w-0 flex-col gap-1"><span>{label}</span><span id={descriptionId} className="text-xs font-normal text-muted-foreground">{description}</span></span>
    </Button>
  );
}

function ClearSharedApprovals({ storageMode, saving, onClearApprovals }: { storageMode: WorkspaceEnvironmentStorageMode; saving: boolean; onClearApprovals: () => Promise<void> }) {
  if (storageMode !== "shared") return null;
  return <Button type="button" variant="ghost" size="sm" className="w-fit" disabled={saving} onClick={() => { void onClearApprovals(); }}>Clear shared command approvals</Button>;
}

function EnvironmentSetupSection({
  draft,
  setupEnabled,
  firstTaskRef,
  setupScriptRef,
  onSetSetup,
  onDraftChange,
}: {
  draft: WorkspaceEnvironmentDocument;
  setupEnabled: boolean;
  firstTaskRef: RefObject<HTMLButtonElement | null>;
  setupScriptRef: RefObject<HTMLTextAreaElement | null>;
  onSetSetup: (enabled: boolean) => void;
  onDraftChange: Dispatch<SetStateAction<WorkspaceEnvironmentDocument>>;
}) {
  return (
    <section aria-labelledby="project-environment-setup-title" className="space-y-3 border-t border-border/60 pt-6">
      <div className="flex items-center justify-between gap-3">
        <div><h2 id="project-environment-setup-title" className="text-base font-semibold">Setup</h2><p className="mt-1 text-xs text-muted-foreground">Optional setup command configuration for this Project.</p></div>
        <Button ref={firstTaskRef} type="button" variant="outline" size="sm" onClick={() => onSetSetup(!setupEnabled)}>{setupEnabled ? "Remove Setup" : "Add Setup"}</Button>
      </div>
      <EnvironmentSetupEditor setup={setupEnabled ? draft.setup : undefined} setupScriptRef={setupScriptRef} onDraftChange={onDraftChange} />
    </section>
  );
}

function EnvironmentSetupEditor({
  setup,
  setupScriptRef,
  onDraftChange,
}: {
  setup: WorkspaceEnvironmentCommand | undefined;
  setupScriptRef: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: Dispatch<SetStateAction<WorkspaceEnvironmentDocument>>;
}) {
  if (!setup) return null;
  return <PlatformCommandEditor idPrefix="setup" command={setup} onChange={(nextSetup) => onDraftChange((current) => ({ ...current, setup: nextSetup }))} firstControlRef={setupScriptRef} />;
}

function EnvironmentActionsSection({
  actions,
  firstActionNameRef,
  onAddAction,
  onUpdateAction,
  onRemoveAction,
}: {
  actions: WorkspaceEnvironmentAction[];
  firstActionNameRef: RefObject<HTMLInputElement | null>;
  onAddAction: () => void;
  onUpdateAction: (id: string, action: WorkspaceEnvironmentAction) => void;
  onRemoveAction: (id: string) => void;
}) {
  return (
    <section aria-labelledby="project-environment-actions-title" className="space-y-3 border-t border-border/60 pt-6">
      <div className="flex items-center justify-between gap-3">
        <div><h2 id="project-environment-actions-title" className="text-base font-semibold">Project actions</h2><p className="mt-1 text-xs text-muted-foreground">Save named commands for this Project.</p></div>
        <Button type="button" variant="outline" size="sm" aria-label="Add action" onClick={onAddAction}><Plus size={15} aria-hidden /> Add action</Button>
      </div>
      <EnvironmentActionList actions={actions} firstActionNameRef={firstActionNameRef} onUpdateAction={onUpdateAction} onRemoveAction={onRemoveAction} />
    </section>
  );
}

function EnvironmentActionList({
  actions,
  firstActionNameRef,
  onUpdateAction,
  onRemoveAction,
}: Omit<Parameters<typeof EnvironmentActionsSection>[0], "onAddAction">) {
  if (actions.length === 0) return <p className="text-xs text-muted-foreground">No project actions configured.</p>;
  return (
    <div className="space-y-8">
      {actions.map((action, index) => <ActionEditor key={action.id} action={action} onChange={(next) => onUpdateAction(action.id, next)} onRemove={() => onRemoveAction(action.id)} nameRef={index === actions.length - 1 ? firstActionNameRef : undefined} />)}
    </div>
  );
}

function EnvironmentMessages({ error, status }: { error: string[] | null; status: string | null }) {
  return (
    <>
      {error ? <div className="max-h-32 overflow-y-auto rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs" role="alert" tabIndex={0} aria-label="Project environment errors">{error.map((message, index) => <p key={`${message}-${index}`}>{message}</p>)}</div> : null}
      {status ? <p className="text-xs text-muted-foreground" role="status">{status}</p> : null}
    </>
  );
}

/** Right-panel editor for one Project environment document. */
export function ProjectEnvironmentPanel({ workspaceId, threadId, active = true }: {
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly active?: boolean;
}) {
  const projectName = useWorkspaceStore((state) =>
    state.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "Unknown project",
  );
  const [draft, setDraft] = useState<WorkspaceEnvironmentDocument>(EMPTY_DOCUMENT);
  const [revision, setRevision] = useState<string | null>(null);
  const [storageMode, setStorageMode] = useState<WorkspaceEnvironmentStorageMode>("system");
  const scopeId = `${workspaceId}:${threadId ?? "base"}`;
  const systemStorageDescriptionId = `${scopeId}-system-storage-description`;
  const sharedStorageDescriptionId = `${scopeId}-shared-storage-description`;
  const [loadedScopeId, setLoadedScopeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [setupEnabled, setSetupEnabled] = useState(false);
  const [confirmSharedStorage, setConfirmSharedStorage] = useState(false);
  const draftRef = useRef(draft);
  const focusAfterRead = useRef(false);
  const firstTaskRef = useRef<HTMLButtonElement | null>(null);
  const setupScriptRef = useRef<HTMLTextAreaElement | null>(null);
  const firstActionNameRef = useRef<HTMLInputElement | null>(null);

  const applyRead = useCallback((result: WorkspaceEnvironmentReadResult) => {
    draftRef.current = result.document;
    setDraft(result.document);
    setSetupEnabled(Boolean(result.document.setup));
    setRevision(result.revision);
    setStorageMode(result.storageMode ?? "system");
    setLoadedScopeId(scopeId);
    setError(null);
    focusAfterRead.current = true;
  }, [scopeId]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const { reload, save, changeStorageMode, clearApprovals } = useEnvironmentPersistence({
    workspaceId,
    threadId,
    scopeId,
    revision,
    draftRef,
    applyRead,
    setRevision,
    setLoadedScopeId,
    setLoading,
    setSaving,
    setStatus,
    setError,
    setConfirmSharedStorage,
    firstTaskRef,
  });

  useEffect(() => {
    if (loadedScopeId !== scopeId) void reload();
  }, [loadedScopeId, reload, scopeId]);

  useEffect(() => {
    if (!active || loading || !focusAfterRead.current) return;
    focusAfterRead.current = false;
    requestAnimationFrame(() => firstTaskRef.current?.focus());
  }, [active, loading]);

  const { setSetup, addAction, updateAction, removeAction } = useEnvironmentDraftActions(
    setDraft,
    setSetupEnabled,
    setupScriptRef,
    firstTaskRef,
    firstActionNameRef,
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden" aria-labelledby="project-environment-title">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-32">
        <div className="space-y-7">
          <header className="space-y-1">
            <h1 id="project-environment-title" className="text-base font-semibold">Project settings</h1>
            <p className="text-xs text-muted-foreground">{projectName}</p>
          </header>
          <EnvironmentMessages error={error} status={status} />
          {loading ? <p className="text-xs text-muted-foreground">Loading environment...</p> : (
            <>
            <EnvironmentStorageSection
              storageMode={storageMode}
              saving={saving}
              systemStorageDescriptionId={systemStorageDescriptionId}
              sharedStorageDescriptionId={sharedStorageDescriptionId}
              onChangeStorageMode={changeStorageMode}
              onConfirmSharedStorage={setConfirmSharedStorage}
              onClearApprovals={clearApprovals}
            />
            <EnvironmentSetupSection
              draft={draft}
              setupEnabled={setupEnabled}
              firstTaskRef={firstTaskRef}
              setupScriptRef={setupScriptRef}
              onSetSetup={setSetup}
              onDraftChange={setDraft}
            />
            <EnvironmentActionsSection
              actions={draft.actions}
              firstActionNameRef={firstActionNameRef}
              onAddAction={addAction}
              onUpdateAction={updateAction}
              onRemoveAction={removeAction}
            />
            </>
          )}
        </div>
      </div>
      <footer className="flex shrink-0 justify-end gap-2 border-t border-border/60 px-3 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => void reload(true)} disabled={loading || saving}>
          <RefreshCw size={14} aria-hidden /> Reload
        </Button>
        <Button type="button" size="sm" onClick={() => void save()} disabled={loading || saving}>
          <Save size={14} aria-hidden /> {saving ? "Saving..." : "Save"}
        </Button>
      </footer>
      <Dialog open={confirmSharedStorage} onOpenChange={setConfirmSharedStorage}>
        <DialogContent showCloseButton={!saving}>
          <DialogHeader>
            <DialogTitle>Share this Project environment?</DialogTitle>
            <DialogDescription className="space-y-4">
              <p>
                Save this Project environment in <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">.mcode/environment.json</code> in the {threadId ? "current checkout" : "base checkout"}.
              </p>
              <p>Before a Setup command or Project action runs from this file, Mcode asks for your approval.</p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => setConfirmSharedStorage(false)}>Cancel</Button>
            <Button type="button" disabled={saving} onClick={() => { void changeStorageMode("shared"); }}>
              {saving ? "Sharing..." : "Share environment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
