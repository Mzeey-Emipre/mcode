import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import type {
  WorkspaceEnvironmentAction,
  WorkspaceEnvironmentCommand,
  WorkspaceEnvironmentDocument,
} from "@mcode/contracts";
import { Button } from "@/components/ui/button";
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

/** Right-panel editor for one private workspace Project environment document. */
export function ProjectEnvironmentPanel({ workspaceId, active = true }: { readonly workspaceId: string; readonly active?: boolean }) {
  const projectName = useWorkspaceStore((state) =>
    state.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "Unknown project",
  );
  const [draft, setDraft] = useState<WorkspaceEnvironmentDocument>(EMPTY_DOCUMENT);
  const [revision, setRevision] = useState<string | null>(null);
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [setupEnabled, setSetupEnabled] = useState(false);
  const draftRef = useRef(draft);
  const focusAfterRead = useRef(false);
  const firstTaskRef = useRef<HTMLButtonElement | null>(null);
  const firstActionNameRef = useRef<HTMLInputElement | null>(null);

  const applyRead = useCallback((result: { document: WorkspaceEnvironmentDocument; revision: string | null }) => {
    draftRef.current = result.document;
    setDraft(result.document);
    setSetupEnabled(Boolean(result.document.setup));
    setRevision(result.revision);
    setLoadedWorkspaceId(workspaceId);
    setError(null);
    focusAfterRead.current = true;
  }, [workspaceId]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const reload = useCallback(async () => {
    setLoading(true);
    setStatus(null);
    try {
      const result = await getTransport().readWorkspaceEnvironment(workspaceId);
      applyRead(result);
      setStatus("Environment reloaded");
    } catch (nextError) {
      setError(issueText(nextError));
    } finally {
      setLoading(false);
    }
  }, [applyRead, workspaceId]);

  useEffect(() => {
    if (loadedWorkspaceId !== workspaceId) void reload();
  }, [loadedWorkspaceId, reload, workspaceId]);

  useEffect(() => {
    if (!active || loading || !focusAfterRead.current) return;
    focusAfterRead.current = false;
    requestAnimationFrame(() => firstTaskRef.current?.focus());
  }, [active, loading]);

  const save = async () => {
    const submittedDraft = draftRef.current;
    const submittedDraftJson = JSON.stringify(submittedDraft);
    setSaving(true);
    setStatus(null);
    try {
      const result = await getTransport().saveWorkspaceEnvironment(workspaceId, submittedDraft, revision);
      setRevision(result.revision);
      setLoadedWorkspaceId(workspaceId);
      if (JSON.stringify(draftRef.current) === submittedDraftJson) applyRead(result);
      useProjectActionStore.getState().invalidateWorkspaceConfiguration(workspaceId);
      setStatus("Environment saved");
      requestAnimationFrame(() => firstTaskRef.current?.focus());
    } catch (nextError) {
      setError(issueText(nextError));
    } finally {
      setSaving(false);
    }
  };

  const setSetup = (enabled: boolean) => {
    setSetupEnabled(enabled);
    setDraft((current) => ({
      ...current,
      setup: enabled ? current.setup ?? { default: "" } : undefined,
    }));
    requestAnimationFrame(() => firstTaskRef.current?.focus());
  };

  const addAction = () => {
    const action = newAction();
    setDraft((current) => ({ ...current, actions: [...current.actions, action] }));
    requestAnimationFrame(() => firstActionNameRef.current?.focus());
  };

  const updateAction = (id: string, action: WorkspaceEnvironmentAction) => {
    setDraft((current) => ({
      ...current,
      actions: current.actions.map((candidate) => candidate.id === id ? action : candidate),
    }));
  };

  const removeAction = (id: string) => {
    setDraft((current) => ({ ...current, actions: current.actions.filter((candidate) => candidate.id !== id) }));
    requestAnimationFrame(() => firstTaskRef.current?.focus());
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden" aria-labelledby="project-environment-title">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-32">
        <div className="space-y-8">
          <header>
            <h1 id="project-environment-title" className="text-base font-semibold">Project settings</h1>
            <p className="mt-1 text-xs text-muted-foreground">{projectName}</p>
          </header>
          {error ? (
            <div className="max-h-32 overflow-y-auto rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs" role="alert" tabIndex={0} aria-label="Project environment errors">
              {error.map((message, index) => <p key={`${message}-${index}`}>{message}</p>)}
            </div>
          ) : null}
          {status ? <p className="text-xs text-muted-foreground" role="status">{status}</p> : null}
          {loading ? <p className="text-xs text-muted-foreground">Loading environment...</p> : (
            <>
            <section aria-labelledby="project-environment-storage-title">
              <h2 id="project-environment-storage-title" className="text-sm font-semibold">Environment</h2>
              <div className="mt-3 px-1 py-4">
                <p className="text-xs text-muted-foreground">This document is saved in Mcode’s user data on this computer.</p>
              </div>
            </section>
            <section aria-labelledby="project-environment-setup-title" className="space-y-4 pt-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 id="project-environment-setup-title" className="text-base font-semibold">Setup</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Optional setup command configuration for this Project.</p>
                </div>
                <Button ref={firstTaskRef} type="button" variant="outline" size="sm" onClick={() => setSetup(!setupEnabled)}>
                  {setupEnabled ? "Remove Setup" : "Add Setup"}
                </Button>
              </div>
              {setupEnabled && draft.setup ? (
                <PlatformCommandEditor
                  idPrefix="setup"
                  command={draft.setup}
                  onChange={(setup) => setDraft((current) => ({ ...current, setup }))}
                  firstControlRef={undefined}
                />
                ) : null}
            </section>
            <section aria-labelledby="project-environment-actions-title" className="space-y-4 pt-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 id="project-environment-actions-title" className="text-base font-semibold">Project actions</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Save named commands for this Project.</p>
                </div>
                <Button type="button" variant="outline" size="sm" aria-label="Add action" onClick={addAction}>
                  <Plus size={15} aria-hidden /> Add action
                </Button>
              </div>
              {draft.actions.length === 0 ? <p className="text-xs text-muted-foreground">No project actions configured.</p> : (
                <div className="space-y-8">
                  {draft.actions.map((action, index) => (
                    <ActionEditor
                      key={action.id}
                      action={action}
                      onChange={(next) => updateAction(action.id, next)}
                      onRemove={() => removeAction(action.id)}
                      nameRef={index === draft.actions.length - 1 ? firstActionNameRef : undefined}
                    />
                  ))}
                </div>
              )}
            </section>
            </>
          )}
        </div>
      </div>
      <footer className="flex shrink-0 justify-end gap-2 border-t border-border/60 px-3 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => void reload()} disabled={loading || saving}>
          <RefreshCw size={14} aria-hidden /> Reload
        </Button>
        <Button type="button" size="sm" onClick={() => void save()} disabled={loading || saving}>
          <Save size={14} aria-hidden /> {saving ? "Saving..." : "Save"}
        </Button>
      </footer>
    </section>
  );
}
