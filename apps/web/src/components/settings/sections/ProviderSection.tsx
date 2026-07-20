import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { SettingRow, SETTING_ROW_GRID_CLASS } from "../SettingRow";
import { SettingsGroup } from "../SettingsGroup";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ProviderAvailability, ProviderId } from "@mcode/contracts";
import { ConfirmDisableDialog } from "./ConfirmDisableDialog";

/** Provider IDs that expose a CLI path input field. */
type CliProvider = "claude" | "codex" | "copilot" | "cursor";
const HAS_CLI_INPUT: readonly CliProvider[] = ["claude", "codex", "copilot", "cursor"];

/** Narrows a ProviderId to those that have an editable CLI path setting. */
function hasCliInput(id: ProviderId): id is CliProvider {
  return (HAS_CLI_INPUT as readonly string[]).includes(id);
}

/**
 * Settings section for enabling AI providers and configuring their CLI paths.
 * Available providers expose a collapsible CLI path input. Beta providers start
 * expanded so their configuration stays available before they are enabled.
 */
export function ProviderSection() {
  const providers = useProviderAvailabilityStore((s) => s.providers);
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const [pendingDisable, setPendingDisable] = useState<ProviderId | null>(null);

  // Count how many adapter-backed providers are currently enabled, so we can
  // prevent the user from disabling the last one.
  const enabledCount = providers.filter((p) => p.enabled && p.hasAdapter).length;

  async function flipEnabled(id: ProviderId, next: boolean) {
    if (!next) {
      // Block turning off the last enabled adapter-backed provider.
      const isLastEnabled = enabledCount === 1 && providers.find((p) => p.id === id)?.enabled;
      if (isLastEnabled) return;

      // Warn before disabling a provider that is currently set as the default.
      const isDefault =
        settings.model.defaults.provider === id || settings.model.utility.provider === id;
      if (isDefault) {
        setPendingDisable(id);
        return;
      }
    }
    await update({ provider: { enabled: { [id]: next } } });
  }

  return (
    <div>
      <SettingsGroup
        title="Providers"
        description="Enable providers and configure their CLI paths."
      >
        {providers.map((p) => (
          <ProviderRow
            key={p.id}
            row={p}
            isLastEnabled={enabledCount === 1 && p.enabled && p.hasAdapter}
            onToggle={(next) => flipEnabled(p.id, next)}
            cliPath={hasCliInput(p.id) ? settings.provider.cli[p.id] : undefined}
            onCliPathChange={
              hasCliInput(p.id)
                ? (val: string) => void update({ provider: { cli: { [p.id]: val } } })
                : undefined
            }
          />
        ))}
      </SettingsGroup>
      {pendingDisable && (
        <ConfirmDisableDialog
          providerId={pendingDisable}
          onCancel={() => setPendingDisable(null)}
          onConfirm={async () => {
            setPendingDisable(null);
          }}
        />
      )}
    </div>
  );
}

interface ProviderRowProps {
  /** Availability and configuration snapshot for this provider. */
  row: ProviderAvailability;
  /** True when this is the only enabled adapter-backed provider. */
  isLastEnabled: boolean;
  /** Called when the user flips the enable toggle. */
  onToggle: (next: boolean) => void | Promise<void>;
  /** Current CLI path setting value; undefined for providers without CLI path config. */
  cliPath: string | undefined;
  /** Called when the user edits the CLI path; undefined when no CLI path config exists. */
  onCliPathChange?: (v: string) => void;
}

/**
 * Single provider row with a disclosure for editable CLI path configuration.
 */
function ProviderRow({ row, isLastEnabled, onToggle, cliPath, onCliPathChange }: ProviderRowProps) {
  // Coming-soon and adapter-less providers cannot be toggled; the last enabled
  // provider also blocks toggling to prevent an unusable state.
  const switchDisabled = row.comingSoon || !row.hasAdapter || isLastEnabled;
  const canConfigure = !row.comingSoon && onCliPathChange != null;
  const [isConfigOpen, setIsConfigOpen] = useState(row.beta);
  const label = labelFor(row.id);
  const hint = hintFor(row, isLastEnabled);

  const controls = (
    <div className="flex items-center gap-2">
      {row.beta && (
        <Tooltip>
          <TooltipTrigger>
            <Badge variant="secondary" data-testid={`provider-badge-${row.id}-beta`}>
              Beta
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            This provider is in early phase. Expect bugs or incomplete features.
          </TooltipContent>
        </Tooltip>
      )}
      {row.comingSoon && (
        <Badge variant="outline" data-testid={`provider-badge-${row.id}-comingsoon`}>
          Coming soon
        </Badge>
      )}
      {row.enabled && row.cli.status === "not_found" && (
        <Tooltip>
          <TooltipTrigger>
            <Badge variant="destructive" data-testid={`provider-badge-${row.id}-cli-missing`}>
              CLI not found
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Tried:{" "}
            {row.cli.configuredPath ? row.cli.configuredPath : "PATH lookup"}. Install
            the CLI or set the path below.
          </TooltipContent>
        </Tooltip>
      )}
      <Switch
        data-testid={`provider-switch-${row.id}`}
        checked={row.enabled && row.hasAdapter}
        disabled={switchDisabled}
        onCheckedChange={onToggle}
      />
    </div>
  );

  if (!canConfigure) {
    return (
      <SettingRow label={label} hint={hint}>
        {controls}
      </SettingRow>
    );
  }

  return (
    <Collapsible open={isConfigOpen} onOpenChange={setIsConfigOpen}>
      <div className="border-b border-border/50 px-1 py-4 last:border-b-0">
        <div className={SETTING_ROW_GRID_CLASS}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid={`provider-config-trigger-${row.id}`}
              aria-label={`${isConfigOpen ? "Hide" : "Show"} ${label} configuration`}
              className="-ml-2 h-auto w-full min-w-0 items-start justify-between gap-4 rounded-md px-2 py-1 text-left hover:bg-accent/60"
            >
              <span className="flex min-w-0 flex-col items-start">
                <span className="text-sm font-semibold text-foreground">{label}</span>
                {hint && <span className="mt-1 text-xs text-muted-foreground">{hint}</span>}
              </span>
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                  isConfigOpen && "rotate-180",
                )}
                aria-hidden
              />
            </Button>
          </CollapsibleTrigger>
          {controls}
        </div>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
          <div
            className={cn(
              SETTING_ROW_GRID_CLASS,
              "mt-3 border-t border-border/40 pt-3 pl-2",
            )}
          >
            <label htmlFor={`provider-cli-path-${row.id}`} className="text-sm font-medium text-foreground">
              {label} CLI path
            </label>
            <Input
              id={`provider-cli-path-${row.id}`}
              data-testid={`provider-cli-path-${row.id}`}
              value={cliPath ?? ""}
              onChange={(e) => onCliPathChange(e.target.value)}
              placeholder={row.id}
              className="h-7 w-56 text-xs"
            />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/** Returns the human-readable display name for a provider ID. */
function labelFor(id: ProviderId): string {
  if (id === "copilot") return "GitHub Copilot";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Returns the hint text shown below the provider label. */
function hintFor(row: ProviderAvailability, isLastEnabled: boolean): string {
  if (isLastEnabled) return "At least one provider must be enabled.";
  if (row.comingSoon) return "Adapter not available yet.";
  if (row.enabled && row.cli.status === "not_found") {
    return `CLI not found${row.cli.configuredPath ? ` at ${row.cli.configuredPath}` : ""}.`;
  }
  return "";
}
