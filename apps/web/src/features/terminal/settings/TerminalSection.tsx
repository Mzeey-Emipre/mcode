import { useEffect, useMemo, useState } from "react";
import type {
  TerminalCustomProfile,
  TerminalPreferencesUpdate,
  TerminalProfileReference,
  TerminalProfileRecovery,
  TerminalResolvedProfile,
  TerminalSettings,
} from "@mcode/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTerminalSettingsStore, type TerminalWorkspaceOverride } from "./terminalSettingsStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { RangeControl } from "@/components/settings/RangeControl";
import { SectionHeading } from "@/components/settings/SectionHeading";
import { SegControl } from "@/components/settings/SegControl";
import { SettingRow } from "@/components/settings/SettingRow";

const INHERIT_PROFILE = "__terminal_inherit__";

const profileName = (profileId: TerminalProfileReference): string => {
  if (profileId === "automatic") return "Automatic";
  if (profileId.startsWith("custom:")) return "Custom profile";
  return profileId
    .replace("certified:", "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
};

const terminalFieldClassName =
  "bg-transparent shadow-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

interface ProfileDialogProps {
  open: boolean;
  profile: TerminalCustomProfile | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: Omit<TerminalCustomProfile, "id">, profileId?: string) => Promise<boolean>;
}

function ProfileDialog({ open, profile, pending, onOpenChange, onSubmit }: ProfileDialogProps) {
  const [name, setName] = useState("");
  const [executable, setExecutable] = useState("");
  const [argumentsText, setArgumentsText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(profile?.name ?? "");
    setExecutable(profile?.executable ?? "");
    setArgumentsText(profile?.arguments.join("\n") ?? "");
    setError(null);
  }, [open, profile]);

  const submit = async () => {
    const input = {
      name: name.trim(),
      executable: executable.trim(),
      arguments: argumentsText.split("\n").map((value) => value.trim()).filter(Boolean),
    };
    if (!input.name || !input.executable) {
      setError("Enter a name and executable.");
      return;
    }
    const saved = await onSubmit(input, profile?.id);
    if (saved) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{profile ? "Edit custom profile" : "Add custom profile"}</DialogTitle>
          <DialogDescription>Changes apply to new terminals.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm">
            Name
            <Input
              aria-label="Profile name"
              value={name}
              maxLength={64}
              className={terminalFieldClassName}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Executable
            <Input
              aria-label="Profile executable"
              value={executable}
              maxLength={1024}
              className={terminalFieldClassName}
              onChange={(event) => setExecutable(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Arguments
            <Textarea
              aria-label="Profile arguments"
              value={argumentsText}
              className="min-h-28 resize-none"
              onChange={(event) => setArgumentsText(event.target.value)}
              placeholder="One argument per line"
            />
          </label>
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={pending} onClick={() => void submit()}>{pending ? "Saving…" : "Save profile"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProfileSelect({
  value,
  certified,
  custom,
  disabled,
  onChange,
  allowInherit = false,
}: {
  value: string;
  certified: readonly { id: TerminalProfileReference; name: string }[];
  custom: readonly TerminalCustomProfile[];
  disabled?: boolean;
  onChange: (value: string) => void;
  allowInherit?: boolean;
}) {
  const selectedLabel = terminalProfileLabel(value, certified, custom);
  const unavailable = terminalProfileUnavailable(value, certified, custom);

  return (
    <Select value={value} onValueChange={(next) => { if (next) onChange(next); }} disabled={disabled}>
      <SelectTrigger aria-label={allowInherit ? "Workspace Terminal profile" : "Default Terminal profile"} className="w-full min-w-52 sm:w-64">
        <SelectValue>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allowInherit ? <SelectItem value={INHERIT_PROFILE}>Use inherited global profile</SelectItem> : null}
        <SelectItem value="automatic">Automatic</SelectItem>
        {certified.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}
        {custom.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}
        {unavailable ? <SelectItem value={value}>{`Unavailable: ${profileName(value as TerminalProfileReference)}`}</SelectItem> : null}
      </SelectContent>
    </Select>
  );
}

function terminalProfileLabel(
  value: string,
  certified: readonly { id: TerminalProfileReference; name: string }[],
  custom: readonly TerminalCustomProfile[],
): string {
  if (value === INHERIT_PROFILE) return "Use inherited global profile";
  if (value === "automatic") return "Automatic";
  return certified.find((profile) => profile.id === value)?.name
    ?? custom.find((profile) => profile.id === value)?.name
    ?? `Unavailable: ${profileName(value as TerminalProfileReference)}`;
}

function terminalProfileUnavailable(
  value: string,
  certified: readonly { id: TerminalProfileReference; name: string }[],
  custom: readonly TerminalCustomProfile[],
): boolean {
  if (value === INHERIT_PROFILE || value === "automatic") return false;
  return !certified.some((profile) => profile.id === value)
    && !custom.some((profile) => profile.id === value);
}

function PreferencesStatus({ pending, error }: { pending: boolean; error: string | null }) {
  if (error) return <p role="alert" className="mb-3 text-xs text-destructive">{error}</p>;
  if (pending) return <p role="status" className="mb-3 text-xs text-muted-foreground" aria-live="polite">Saving Terminal preferences…</p>;
  return null;
}

type TerminalProfileOption = {
  readonly id: TerminalProfileReference;
  readonly name: string;
};

interface TerminalSectionModel {
  readonly activeWorkspaceId: string | null;
  readonly certifiedProfiles: readonly TerminalResolvedProfile[];
  readonly certifiedOptions: readonly TerminalProfileOption[];
  readonly customProfiles: readonly TerminalCustomProfile[];
  readonly recovery: TerminalProfileRecovery | null;
  readonly profilesLoaded: boolean;
  readonly profilesLoading: boolean;
  readonly workspaceOverride: TerminalWorkspaceOverride | null;
  readonly workspaceLoading: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly deleteReferences: {
    readonly globalDefault: boolean;
    readonly workspaceIds: readonly string[];
  } | null;
  readonly globalDefault: TerminalProfileReference;
  readonly workspaceValue: string;
  readonly automaticProfile: TerminalResolvedProfile | undefined;
  readonly selectedProfileUnavailable: boolean;
  readonly terminalSettings: TerminalSettings;
  readonly profileDialogOpen: boolean;
  readonly editingProfile: TerminalCustomProfile | null;
  readonly fontFamilyDraft: string;
  readonly setFontFamilyDraft: (value: string) => void;
  readonly commitFontFamily: () => void;
  readonly selectGlobalProfile: (value: string) => void;
  readonly selectWorkspaceProfile: (value: string) => void;
  readonly resetWorkspaceProfile: () => void;
  readonly openNewProfileDialog: () => void;
  readonly openEditProfileDialog: (profile: TerminalCustomProfile) => void;
  readonly setProfileDialogOpen: (open: boolean) => void;
  readonly saveProfile: (input: Omit<TerminalCustomProfile, "id">, profileId?: string) => Promise<boolean>;
  readonly deleteProfile: (profileId: string) => void;
  readonly updatePresentation: <K extends keyof TerminalSettings["presentation"]>(
    key: K,
    value: TerminalSettings["presentation"][K],
  ) => void;
  readonly updateBehavior: <K extends keyof TerminalSettings["behavior"]>(
    key: K,
    value: TerminalSettings["behavior"][K],
  ) => void;
  readonly updateAccessibility: (mode: TerminalSettings["accessibility"]["screenReaderMode"]) => void;
  readonly resetTerminalPreferences: () => void;
}

function useTerminalSectionModel(): TerminalSectionModel {
  const settings = useSettingsStore((state) => state.settings);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const {
    certifiedProfiles,
    customProfiles,
    recovery,
    profilesLoaded,
    profilesLoading,
    workspaceOverride,
    workspaceLoading,
    pending,
    error,
    deleteReferences,
    fetchProfiles,
    fetchWorkspaceOverride,
    setGlobalDefault,
    setWorkspaceDefault,
    resetWorkspaceDefault,
    createProfile,
    updateProfile,
    deleteProfile,
    updatePreferences,
    resetPreferences,
    clearError,
  } = useTerminalSettingsStore();
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<TerminalCustomProfile | null>(null);
  const [fontFamilyDraft, setFontFamilyDraft] = useState(settings.terminal.presentation.fontFamily);

  useEffect(() => { void fetchProfiles(); }, [fetchProfiles]);
  useEffect(() => {
    if (activeWorkspaceId) void fetchWorkspaceOverride(activeWorkspaceId);
  }, [activeWorkspaceId, fetchWorkspaceOverride]);

  const certifiedOptions = useMemo(
    () => certifiedProfiles.map((profile) => ({ id: profile.id, name: profile.name })),
    [certifiedProfiles],
  );
  const globalDefault = recovery?.unavailableProfileId ?? settings.terminal.defaultProfileId;
  const workspaceValue = workspaceOverride?.defaultProfileId ?? INHERIT_PROFILE;
  const automaticProfile = certifiedProfiles[0];
  const selectedProfileUnavailable = Boolean(recovery?.unavailableProfileId)
    || terminalProfileUnavailable(globalDefault, certifiedOptions, customProfiles);
  const presentation = settings.terminal.presentation;
  useEffect(() => {
    setFontFamilyDraft(presentation.fontFamily);
  }, [presentation.fontFamily]);
  const update = (input: Parameters<typeof updatePreferences>[0]) => { void updatePreferences(input); };
  const updatePresentation = <K extends keyof TerminalSettings["presentation"]>(key: K, value: TerminalSettings["presentation"][K]) => update({ presentation: { [key]: value } } as TerminalPreferencesUpdate);
  const updateBehavior = <K extends keyof TerminalSettings["behavior"]>(key: K, value: TerminalSettings["behavior"][K]) => update({ behavior: { [key]: value } } as TerminalPreferencesUpdate);
  const commitFontFamily = () => {
    const value = fontFamilyDraft.trim();
    if (!value) {
      setFontFamilyDraft(presentation.fontFamily);
      return;
    }
    if (value !== presentation.fontFamily) {
      updatePresentation("fontFamily", value);
    } else if (fontFamilyDraft !== value) {
      setFontFamilyDraft(value);
    }
  };

  const selectWorkspaceProfile = (value: string) => {
    if (!activeWorkspaceId) return;
    if (value === INHERIT_PROFILE) {
      void resetWorkspaceDefault(activeWorkspaceId);
      return;
    }
    void setWorkspaceDefault(activeWorkspaceId, value as TerminalProfileReference);
  };

  const resetWorkspaceProfile = () => {
    if (activeWorkspaceId) void resetWorkspaceDefault(activeWorkspaceId);
  };

  const saveProfile = (input: Omit<TerminalCustomProfile, "id">, profileId?: string) =>
    profileId ? updateProfile({ ...input, profileId }) : createProfile(input);

  return {
    activeWorkspaceId,
    certifiedProfiles,
    certifiedOptions,
    customProfiles,
    recovery,
    profilesLoaded,
    profilesLoading,
    workspaceOverride,
    workspaceLoading,
    pending,
    error,
    deleteReferences,
    globalDefault,
    workspaceValue,
    automaticProfile,
    selectedProfileUnavailable,
    terminalSettings: settings.terminal,
    profileDialogOpen,
    editingProfile,
    fontFamilyDraft,
    setFontFamilyDraft,
    commitFontFamily,
    selectGlobalProfile: (value) => { void setGlobalDefault(value as TerminalProfileReference); },
    selectWorkspaceProfile,
    resetWorkspaceProfile,
    openNewProfileDialog: () => {
      setEditingProfile(null);
      setProfileDialogOpen(true);
    },
    openEditProfileDialog: (profile) => {
      setEditingProfile(profile);
      setProfileDialogOpen(true);
    },
    setProfileDialogOpen,
    saveProfile,
    deleteProfile: (profileId) => { void deleteProfile(profileId); },
    updatePresentation,
    updateBehavior,
    updateAccessibility: (mode) => update({ accessibility: { screenReaderMode: mode } }),
    resetTerminalPreferences: () => {
      clearError();
      void resetPreferences(activeWorkspaceId ?? undefined);
    },
  };
}

function globalProfileHint(model: TerminalSectionModel): string | undefined {
  if (model.globalDefault === "automatic" && model.automaticProfile) {
    return `Automatic currently uses ${model.automaticProfile.name}.`;
  }
  if (model.selectedProfileUnavailable) return "The selected profile is unavailable. Choose another profile.";
  return undefined;
}

function GlobalProfileDefault({ model }: { readonly model: TerminalSectionModel }) {
  return (
    <SettingRow
      label="Global default profile"
      configKey="terminal.defaultProfileId"
      hint={globalProfileHint(model)}
    >
      <ProfileSelect
        value={model.globalDefault}
        certified={model.certifiedOptions}
        custom={model.customProfiles}
        disabled={!model.profilesLoaded || model.pending}
        onChange={model.selectGlobalProfile}
      />
    </SettingRow>
  );
}

function ProfileRecoveryNotices({ model }: { readonly model: TerminalSectionModel }) {
  return (
    <>
      {model.selectedProfileUnavailable ? (
        <p role="alert" className="mx-1 border-b border-border/50 px-1 py-2 text-xs text-destructive">
          Selected profile is unavailable: {model.globalDefault}
        </p>
      ) : null}
      {model.recovery ? (
        <div role="alert" className="mx-1 border-b border-border/50 px-1 py-2 text-xs text-destructive">
          Terminal settings need repair. Reset Terminal preferences to restore defaults.
        </div>
      ) : null}
    </>
  );
}

function WorkspaceProfileDefault({ model }: { readonly model: TerminalSectionModel }) {
  if (!model.activeWorkspaceId) {
    return <p className="border-b border-border/50 px-1 py-3 text-xs text-muted-foreground">Open a project to set a project default.</p>;
  }

  return (
    <SettingRow
      label="Project default profile"
      configKey="terminal.workspace.defaultProfileId"
      hint="Use the inherited global profile, or choose a project override."
    >
      <div className="flex flex-wrap items-center gap-2">
        <ProfileSelect
          value={model.workspaceValue}
          certified={model.certifiedOptions}
          custom={model.customProfiles}
          disabled={!model.profilesLoaded || model.workspaceLoading || model.pending}
          allowInherit
          onChange={model.selectWorkspaceProfile}
        />
        {model.workspaceOverride ? (
          <Button variant="ghost" size="sm" disabled={model.pending} onClick={model.resetWorkspaceProfile}>
            Use inherited profile
          </Button>
        ) : null}
      </div>
    </SettingRow>
  );
}

function CustomProfileRow({
  profile,
  pending,
  onEdit,
  onDelete,
}: {
  readonly profile: TerminalCustomProfile;
  readonly pending: boolean;
  readonly onEdit: (profile: TerminalCustomProfile) => void;
  readonly onDelete: (profileId: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 px-3 py-2 text-xs">
      <span className="min-w-0 truncate">
        {profile.name}
        <span className="ml-2 text-muted-foreground">{profile.executable}</span>
      </span>
      <span className="flex shrink-0 gap-1">
        <Button variant="ghost" size="xs" disabled={pending} onClick={() => onEdit(profile)}>Edit</Button>
        <Button variant="ghost" size="xs" disabled={pending} onClick={() => onDelete(profile.id)}>Delete</Button>
      </span>
    </div>
  );
}

function ProfileDeleteReferences({ references }: {
  readonly references: TerminalSectionModel["deleteReferences"];
}) {
  if (!references) return null;
  return (
    <div role="alert" className="mx-1 border-b border-border/50 px-1 py-2 text-xs text-destructive">
      This profile is still in use.
      {references.globalDefault ? " It is the global default." : ""}
      {references.workspaceIds.length ? ` Project references: ${references.workspaceIds.join(", ")}.` : ""}
    </div>
  );
}

function TerminalProfileLists({ model }: { readonly model: TerminalSectionModel }) {
  return (
    <>
      <SettingRow label="Certified profiles" hint="Detected profiles are read-only.">
        <div className="grid min-w-52 gap-2 sm:min-w-64">
          {model.profilesLoading && !model.profilesLoaded ? <p className="text-xs text-muted-foreground">Loading profiles…</p> : null}
          {!model.profilesLoading && model.certifiedProfiles.length === 0 ? <p className="text-xs text-muted-foreground">No certified profiles detected.</p> : null}
          {model.certifiedProfiles.map((profile) => (
            <div key={profile.id} className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2 text-xs">
              <span className="min-w-0 truncate">
                {profile.name}
                <span className="ml-2 text-muted-foreground">{profile.executable}</span>
              </span>
              <Badge variant="secondary" size="sm">Detected</Badge>
            </div>
          ))}
        </div>
      </SettingRow>
      <SettingRow label="Custom profiles" hint="Custom profiles remain after a Terminal preference reset.">
        <div className="grid min-w-52 gap-2 sm:min-w-64">
          {model.customProfiles.map((profile) => (
            <CustomProfileRow
              key={profile.id}
              profile={profile}
              pending={model.pending}
              onEdit={model.openEditProfileDialog}
              onDelete={model.deleteProfile}
            />
          ))}
          {model.recovery?.blockedProfiles.map((profile) => (
            <div key={`recovered-${profile.id}`} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 px-3 py-2 text-xs">
              <span className="min-w-0 truncate">
                {profile.name}
                <span className="ml-2 text-muted-foreground">{profile.executable}</span>
              </span>
              <Badge variant="secondary" size="sm">Recovered</Badge>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={model.pending || model.customProfiles.length >= 32}
            onClick={model.openNewProfileDialog}
          >
            Add custom profile
          </Button>
        </div>
      </SettingRow>
      <ProfileDeleteReferences references={model.deleteReferences} />
    </>
  );
}

function TerminalProfilesSection({ model }: { readonly model: TerminalSectionModel }) {
  return (
    <section aria-labelledby="terminal-profiles-heading">
      <h2 id="terminal-profiles-heading" className="mb-1 px-1 text-sm font-semibold text-foreground">Profiles and defaults</h2>
      <p className="mb-2 px-1 text-xs text-muted-foreground">Defaults apply to new terminals.</p>
      <GlobalProfileDefault model={model} />
      <ProfileRecoveryNotices model={model} />
      <WorkspaceProfileDefault model={model} />
      <TerminalProfileLists model={model} />
    </section>
  );
}

function handleFontFamilyKey(
  event: React.KeyboardEvent<HTMLInputElement>,
  resetFontFamilyDraft: () => void,
): void {
  if (event.key === "Enter") {
    event.preventDefault();
    event.currentTarget.blur();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    resetFontFamilyDraft();
  }
}

function TerminalPresentationSection({ model }: { readonly model: TerminalSectionModel }) {
  const presentation = model.terminalSettings.presentation;
  return (
    <section aria-labelledby="terminal-presentation-heading">
      <h2 id="terminal-presentation-heading" className="mb-1 mt-6 px-1 text-sm font-semibold text-foreground">Presentation</h2>
      <SettingRow label="Font family" configKey="terminal.presentation.fontFamily" hint="Changes apply to new and open terminals.">
        <Input
          aria-label="Terminal font family"
          value={model.fontFamilyDraft}
          onChange={(event) => model.setFontFamilyDraft(event.target.value)}
          onBlur={model.commitFontFamily}
          onKeyDown={(event) => handleFontFamilyKey(event, () => model.setFontFamilyDraft(presentation.fontFamily))}
          maxLength={128}
          className={`${terminalFieldClassName} w-full sm:w-64`}
        />
      </SettingRow>
      <SettingRow label="Font size" configKey="terminal.presentation.fontSize">
        <SegControl
          options={(["xs", "sm", "md", "lg", "xl"] as const).map((value) => ({ value, label: value.toUpperCase(), disabled: model.pending }))}
          value={presentation.fontSize}
          onChange={(value) => model.updatePresentation("fontSize", value as typeof presentation.fontSize)}
        />
      </SettingRow>
      <SettingRow label="Line height" configKey="terminal.presentation.lineHeight">
        <SegControl
          options={(["compact", "normal", "relaxed"] as const).map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1), disabled: model.pending }))}
          value={presentation.lineHeight}
          onChange={(value) => model.updatePresentation("lineHeight", value as typeof presentation.lineHeight)}
        />
      </SettingRow>
      <SettingRow label="Cursor style" configKey="terminal.presentation.cursorStyle">
        <SegControl
          options={(["block", "underline", "bar"] as const).map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1), disabled: model.pending }))}
          value={presentation.cursorStyle}
          onChange={(value) => model.updatePresentation("cursorStyle", value as typeof presentation.cursorStyle)}
        />
      </SettingRow>
      <SettingRow label="Cursor blink" configKey="terminal.presentation.cursorBlink">
        <Switch aria-label="Cursor blink" checked={presentation.cursorBlink} disabled={model.pending} onCheckedChange={(value) => model.updatePresentation("cursorBlink", value)} />
      </SettingRow>
      <SettingRow label="Ligatures" configKey="terminal.presentation.ligatures">
        <Switch aria-label="Terminal ligatures" checked={presentation.ligatures} disabled={model.pending} onCheckedChange={(value) => model.updatePresentation("ligatures", value)} />
      </SettingRow>
    </section>
  );
}

function TerminalBehaviorSection({ model }: { readonly model: TerminalSectionModel }) {
  const behavior = model.terminalSettings.behavior;
  return (
    <section aria-labelledby="terminal-behavior-heading">
      <h2 id="terminal-behavior-heading" className="mb-1 mt-6 px-1 text-sm font-semibold text-foreground">Behavior</h2>
      <SettingRow label="Scrollback lines" configKey="terminal.behavior.scrollback" hint="Lines to retain in the buffer.">
        <RangeControl ariaLabel="Scrollback lines" min={100} max={5000} step={100} value={behavior.scrollback} onCommit={(value) => model.updateBehavior("scrollback", value)} />
      </SettingRow>
      <SettingRow label="Session limit" configKey="terminal.behavior.sessionLimit" hint="Maximum retained Terminal sessions.">
        <RangeControl ariaLabel="Session limit" min={1} max={20} value={behavior.sessionLimit} onCommit={(value) => model.updateBehavior("sessionLimit", value)} />
      </SettingRow>
      <SettingRow label="Confirm on kill" configKey="terminal.behavior.confirmOnKill">
        <SegControl
          options={[
            { value: "never", label: "Never", disabled: model.pending },
            { value: "withChildProcesses", label: "With child processes", disabled: model.pending },
            { value: "always", label: "Always", disabled: model.pending },
          ]}
          value={behavior.confirmOnKill}
          onChange={(value) => model.updateBehavior("confirmOnKill", value as typeof behavior.confirmOnKill)}
        />
      </SettingRow>
      <SettingRow label="Copy on select" configKey="terminal.behavior.copyOnSelect">
        <Switch aria-label="Copy on select" checked={behavior.copyOnSelect} disabled={model.pending} onCheckedChange={(value) => model.updateBehavior("copyOnSelect", value)} />
      </SettingRow>
      <SettingRow label="Confirm multiline paste" configKey="terminal.behavior.confirmMultilinePaste">
        <Switch aria-label="Confirm multiline paste" checked={behavior.confirmMultilinePaste} disabled={model.pending} onCheckedChange={(value) => model.updateBehavior("confirmMultilinePaste", value)} />
      </SettingRow>
    </section>
  );
}

function TerminalAccessibilitySection({ model }: { readonly model: TerminalSectionModel }) {
  const accessibility = model.terminalSettings.accessibility;
  return (
    <section aria-labelledby="terminal-accessibility-heading">
      <h2 id="terminal-accessibility-heading" className="mb-1 mt-6 px-1 text-sm font-semibold text-foreground">Accessibility</h2>
      <SettingRow label="Screen reader" configKey="terminal.accessibility.screenReaderMode" hint="Automatic uses the terminal default.">
        <SegControl
          options={[
            { value: "off", label: "Off", disabled: model.pending },
            { value: "auto", label: "Automatic", disabled: model.pending },
            { value: "on", label: "On", disabled: model.pending },
          ]}
          value={accessibility.screenReaderMode}
          onChange={(value) => model.updateAccessibility(value as typeof accessibility.screenReaderMode)}
        />
      </SettingRow>
    </section>
  );
}

function TerminalSectionContent({ model }: { readonly model: TerminalSectionModel }) {
  return (
    <div aria-busy={model.pending || model.profilesLoading || model.workspaceLoading}>
      <SectionHeading>Terminal</SectionHeading>
      <PreferencesStatus pending={model.pending} error={model.error} />
      <TerminalProfilesSection model={model} />
      <TerminalPresentationSection model={model} />
      <TerminalBehaviorSection model={model} />
      <TerminalAccessibilitySection model={model} />
      <div className="mt-6 flex justify-end border-t border-border/50 px-1 pt-4">
        <Button variant="outline" disabled={model.pending} onClick={model.resetTerminalPreferences}>
          Reset Terminal preferences
        </Button>
      </div>
      <ProfileDialog
        open={model.profileDialogOpen}
        profile={model.editingProfile}
        pending={model.pending}
        onOpenChange={model.setProfileDialogOpen}
        onSubmit={model.saveProfile}
      />
    </div>
  );
}

/** Complete global, workspace, presentation, behavior, and accessibility Terminal settings. */
export function TerminalSection() {
  const model = useTerminalSectionModel();

  return <TerminalSectionContent model={model} />;
}
