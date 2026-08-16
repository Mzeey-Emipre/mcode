import { useEffect, useMemo, useState } from "react";
import type {
  TerminalCustomProfile,
  TerminalPreferencesUpdate,
  TerminalProfileReference,
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
import { useTerminalSettingsStore } from "./terminalSettingsStore";
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
  const selectedCertified = certified.find((profile) => profile.id === value);
  const selectedCustom = custom.find((profile) => profile.id === value);
  const selectedLabel = value === INHERIT_PROFILE
    ? "Use inherited global profile"
    : value === "automatic"
      ? "Automatic"
      : selectedCertified?.name
        ?? selectedCustom?.name
        ?? `Unavailable: ${profileName(value as TerminalProfileReference)}`;

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
        {value !== INHERIT_PROFILE && value !== "automatic" && !certified.some((profile) => profile.id === value) && !custom.some((profile) => profile.id === value) ? (
          <SelectItem value={value}>{`Unavailable: ${profileName(value as TerminalProfileReference)}`}</SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}

function PreferencesStatus({ pending, error }: { pending: boolean; error: string | null }) {
  if (error) return <p role="alert" className="mb-3 text-xs text-destructive">{error}</p>;
  if (pending) return <p role="status" className="mb-3 text-xs text-muted-foreground" aria-live="polite">Saving Terminal preferences…</p>;
  return null;
}

/** Complete global, workspace, presentation, behavior, and accessibility Terminal settings. */
export function TerminalSection() {
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
  const selectedProfileUnavailable = Boolean(recovery?.unavailableProfileId) || (globalDefault !== "automatic" && !certifiedProfiles.some((profile) => profile.id === globalDefault) && !customProfiles.some((profile) => profile.id === globalDefault));
  const presentation = settings.terminal.presentation;
  const behavior = settings.terminal.behavior;
  const accessibility = settings.terminal.accessibility;
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

  return (
    <div aria-busy={pending || profilesLoading || workspaceLoading}>
      <SectionHeading>Terminal</SectionHeading>
      <PreferencesStatus pending={pending} error={error} />

      <section aria-labelledby="terminal-profiles-heading">
        <h2 id="terminal-profiles-heading" className="mb-1 px-1 text-sm font-semibold text-foreground">
          Profiles and defaults
        </h2>
        <p className="mb-2 px-1 text-xs text-muted-foreground">Defaults apply to new terminals.</p>
        <SettingRow
          label="Global default profile"
          configKey="terminal.defaultProfileId"
          hint={
            globalDefault === "automatic" && automaticProfile
              ? `Automatic currently uses ${automaticProfile.name}.`
              : selectedProfileUnavailable
                ? "The selected profile is unavailable. Choose another profile."
                : undefined
          }
        >
          <ProfileSelect
            value={globalDefault}
            certified={certifiedOptions}
            custom={customProfiles}
            disabled={!profilesLoaded || pending}
            onChange={(value) => void setGlobalDefault(value as TerminalProfileReference)}
          />
        </SettingRow>
        {selectedProfileUnavailable ? (
          <p role="alert" className="mx-1 border-b border-border/50 px-1 py-2 text-xs text-destructive">
            Selected profile is unavailable: {globalDefault}
          </p>
        ) : null}
        {recovery ? (
          <div role="alert" className="mx-1 border-b border-border/50 px-1 py-2 text-xs text-destructive">
            Terminal settings need repair. Reset Terminal preferences to restore defaults.
          </div>
        ) : null}
        {activeWorkspaceId ? (
          <SettingRow
            label="Project default profile"
            configKey="terminal.workspace.defaultProfileId"
            hint="Use the inherited global profile, or choose a project override."
          >
            <div className="flex flex-wrap items-center gap-2">
              <ProfileSelect
                value={workspaceValue}
                certified={certifiedOptions}
                custom={customProfiles}
                disabled={!profilesLoaded || workspaceLoading || pending}
                allowInherit
                onChange={(value) =>
                  value === INHERIT_PROFILE
                    ? void resetWorkspaceDefault(activeWorkspaceId)
                    : void setWorkspaceDefault(activeWorkspaceId, value as TerminalProfileReference)
                }
              />
              {workspaceOverride ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => void resetWorkspaceDefault(activeWorkspaceId)}
                >
                  Use inherited profile
                </Button>
              ) : null}
            </div>
          </SettingRow>
        ) : (
          <p className="border-b border-border/50 px-1 py-3 text-xs text-muted-foreground">
            Open a project to set a project default.
          </p>
        )}
        <SettingRow label="Certified profiles" hint="Detected profiles are read-only.">
          <div className="grid min-w-52 gap-2 sm:min-w-64">
            {profilesLoading && !profilesLoaded ? (
              <p className="text-xs text-muted-foreground">Loading profiles…</p>
            ) : null}
            {!profilesLoading && certifiedProfiles.length === 0 ? (
              <p className="text-xs text-muted-foreground">No certified profiles detected.</p>
            ) : null}
            {certifiedProfiles.map((profile) => (
              <div
                key={profile.id}
                className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2 text-xs"
              >
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
            {customProfiles.map((profile) => (
              <div
                key={profile.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 px-3 py-2 text-xs"
              >
                <span className="min-w-0 truncate">
                  {profile.name}
                  <span className="ml-2 text-muted-foreground">{profile.executable}</span>
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={pending}
                    onClick={() => {
                      setEditingProfile(profile);
                      setProfileDialogOpen(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={pending}
                    onClick={() => void deleteProfile(profile.id)}
                  >
                    Delete
                  </Button>
                </span>
              </div>
            ))}
            {recovery?.blockedProfiles.map((profile) => (
              <div
                key={`recovered-${profile.id}`}
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 px-3 py-2 text-xs"
              >
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
              disabled={pending || customProfiles.length >= 32}
              onClick={() => {
                setEditingProfile(null);
                setProfileDialogOpen(true);
              }}
            >
              Add custom profile
            </Button>
          </div>
        </SettingRow>
        {deleteReferences ? (
          <div role="alert" className="mx-1 border-b border-border/50 px-1 py-2 text-xs text-destructive">
            This profile is still in use.
            {deleteReferences.globalDefault ? " It is the global default." : ""}
            {deleteReferences.workspaceIds.length
              ? ` Project references: ${deleteReferences.workspaceIds.join(", ")}.`
              : ""}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="terminal-presentation-heading">
        <h2 id="terminal-presentation-heading" className="mb-1 mt-6 px-1 text-sm font-semibold text-foreground">
          Presentation
        </h2>
        <SettingRow label="Font family" configKey="terminal.presentation.fontFamily" hint="Changes apply to new and open terminals.">
          <Input
            aria-label="Terminal font family"
            value={fontFamilyDraft}
            onChange={(event) => setFontFamilyDraft(event.target.value)}
            onBlur={commitFontFamily}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setFontFamilyDraft(presentation.fontFamily);
              }
            }}
            maxLength={128}
            className={`${terminalFieldClassName} w-full sm:w-64`}
          />
        </SettingRow>
        <SettingRow label="Font size" configKey="terminal.presentation.fontSize">
          <SegControl
            options={(["xs", "sm", "md", "lg", "xl"] as const).map((value) => ({
              value,
              label: value.toUpperCase(),
              disabled: pending,
            }))}
            value={presentation.fontSize}
            onChange={(value) => updatePresentation("fontSize", value as typeof presentation.fontSize)}
          />
        </SettingRow>
        <SettingRow label="Line height" configKey="terminal.presentation.lineHeight">
          <SegControl
            options={(["compact", "normal", "relaxed"] as const).map((value) => ({
              value,
              label: value[0].toUpperCase() + value.slice(1),
              disabled: pending,
            }))}
            value={presentation.lineHeight}
            onChange={(value) => updatePresentation("lineHeight", value as typeof presentation.lineHeight)}
          />
        </SettingRow>
        <SettingRow label="Cursor style" configKey="terminal.presentation.cursorStyle">
          <SegControl
            options={(["block", "underline", "bar"] as const).map((value) => ({
              value,
              label: value[0].toUpperCase() + value.slice(1),
              disabled: pending,
            }))}
            value={presentation.cursorStyle}
            onChange={(value) => updatePresentation("cursorStyle", value as typeof presentation.cursorStyle)}
          />
        </SettingRow>
        <SettingRow label="Cursor blink" configKey="terminal.presentation.cursorBlink">
          <Switch
            aria-label="Cursor blink"
            checked={presentation.cursorBlink}
            disabled={pending}
            onCheckedChange={(value) => updatePresentation("cursorBlink", value)}
          />
        </SettingRow>
        <SettingRow label="Ligatures" configKey="terminal.presentation.ligatures">
          <Switch
            aria-label="Terminal ligatures"
            checked={presentation.ligatures}
            disabled={pending}
            onCheckedChange={(value) => updatePresentation("ligatures", value)}
          />
        </SettingRow>
      </section>

      <section aria-labelledby="terminal-behavior-heading">
        <h2 id="terminal-behavior-heading" className="mb-1 mt-6 px-1 text-sm font-semibold text-foreground">
          Behavior
        </h2>
        <SettingRow
          label="Scrollback lines"
          configKey="terminal.behavior.scrollback"
          hint="Lines to retain in the buffer."
        >
          <RangeControl
            ariaLabel="Scrollback lines"
            min={100}
            max={5000}
            step={100}
            value={behavior.scrollback}
            onCommit={(value) => updateBehavior("scrollback", value)}
          />
        </SettingRow>
        <SettingRow
          label="Session limit"
          configKey="terminal.behavior.sessionLimit"
          hint="Maximum retained Terminal sessions."
        >
          <RangeControl
            ariaLabel="Session limit"
            min={1}
            max={20}
            value={behavior.sessionLimit}
            onCommit={(value) => updateBehavior("sessionLimit", value)}
          />
        </SettingRow>
        <SettingRow label="Confirm on kill" configKey="terminal.behavior.confirmOnKill">
          <SegControl
            options={[
              { value: "never", label: "Never", disabled: pending },
              { value: "withChildProcesses", label: "With child processes", disabled: pending },
              { value: "always", label: "Always", disabled: pending },
            ]}
            value={behavior.confirmOnKill}
            onChange={(value) => updateBehavior("confirmOnKill", value as typeof behavior.confirmOnKill)}
          />
        </SettingRow>
        <SettingRow label="Copy on select" configKey="terminal.behavior.copyOnSelect">
          <Switch
            aria-label="Copy on select"
            checked={behavior.copyOnSelect}
            disabled={pending}
            onCheckedChange={(value) => updateBehavior("copyOnSelect", value)}
          />
        </SettingRow>
        <SettingRow label="Confirm multiline paste" configKey="terminal.behavior.confirmMultilinePaste">
          <Switch
            aria-label="Confirm multiline paste"
            checked={behavior.confirmMultilinePaste}
            disabled={pending}
            onCheckedChange={(value) => updateBehavior("confirmMultilinePaste", value)}
          />
        </SettingRow>
      </section>

      <section aria-labelledby="terminal-accessibility-heading">
        <h2 id="terminal-accessibility-heading" className="mb-1 mt-6 px-1 text-sm font-semibold text-foreground">
          Accessibility
        </h2>
        <SettingRow
          label="Screen reader"
          configKey="terminal.accessibility.screenReaderMode"
          hint="Automatic uses the terminal default."
        >
          <SegControl
            options={[
              { value: "off", label: "Off", disabled: pending },
              { value: "auto", label: "Automatic", disabled: pending },
              { value: "on", label: "On", disabled: pending },
            ]}
            value={accessibility.screenReaderMode}
            onChange={(value) =>
              update({ accessibility: { screenReaderMode: value as typeof accessibility.screenReaderMode } })
            }
          />
        </SettingRow>
      </section>

      <div className="mt-6 flex justify-end border-t border-border/50 px-1 pt-4">
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => {
            clearError();
            void resetPreferences(activeWorkspaceId ?? undefined);
          }}
        >
          Reset Terminal preferences
        </Button>
      </div>
      <ProfileDialog
        open={profileDialogOpen}
        profile={editingProfile}
        pending={pending}
        onOpenChange={setProfileDialogOpen}
        onSubmit={(input, profileId) =>
          profileId ? updateProfile({ ...input, profileId }) : createProfile(input)
        }
      />
    </div>
  );
}
