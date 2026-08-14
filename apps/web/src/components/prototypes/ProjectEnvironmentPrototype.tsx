import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleStop,
  Code2,
  Diff,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  ListChecks,
  MoreHorizontal,
  OctagonX,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Settings as GearSettings,
  Settings2,
  ShieldAlert,
  SquareTerminal,
  SquarePen,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SiteFavicon } from "@/components/ui/favicon";
import { Separator } from "@/components/ui/separator";
import { ResizableRightPanel } from "@/components/panels/ResizableRightPanel";
import { McodeLogo } from "@/components/brand/McodeLogo";
import { cn } from "@/lib/utils";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import {
  COMPOSER_MIN_WIDTH,
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_SPLIT_GAP_PX,
  PANEL_WIDE_WIDTH,
} from "@/stores/diffStore";

// Variant A is the selected prototype direction. Settings2 remains the accepted Overview launcher.
const VARIANTS = [
  { key: "A", label: "Guided settings" },
  { key: "B", label: "Command inspector" },
  { key: "C", label: "File and preview" },
] as const;

const SCENARIOS = [
  { key: "ready", label: "Ready" },
  { key: "approval", label: "Approval required" },
  { key: "setup-failed", label: "Setup failed" },
  { key: "setup-missing", label: "Setup not configured" },
  { key: "running", label: "Action running" },
  { key: "completed", label: "Action completed" },
  { key: "interrupted", label: "Action interrupted" },
  { key: "unavailable", label: "Unavailable action" },
] as const;

type VariantKey = (typeof VARIANTS)[number]["key"];
type ScenarioKey = (typeof SCENARIOS)[number]["key"];
type SurfaceKey = "settings" | "thread";
type StorageMode = "system" | "shared";
type PlatformKey = "default" | "macos" | "linux" | "windows";
type ActionKey = "web" | "tests";
type ActionRunState = "idle" | "running" | "completed" | "interrupted" | "unavailable";
type ActionStates = Record<ActionKey, ActionRunState>;
type TerminalState = "running" | "completed" | "interrupted";
type TerminalStates = Record<ActionKey, TerminalState | null>;
type SetupRunState = "idle" | "running" | "completed";
type SettingsTarget = "top" | "setup" | "actions";
type SetupFailureFlowState = "running" | "blocked" | "repairing" | "rerunning" | "retrying" | "passed" | "continued";
type SetupFailureVisibleState = Exclude<SetupFailureFlowState, "retrying">;
type QueuedTurnState = "waiting" | "running" | "completed";
type SetupFailureAction = "fix" | "retry" | "open-terminal" | "continue";
const ACTION_KEYS = ["web", "tests"] as const satisfies readonly ActionKey[];
const ACTION_LABELS: Record<ActionKey, string> = { web: "Start web app", tests: "Run tests" };
const ACTION_COMPLETION_DELAY_MS = 1500;
const ACTION_COMPLETED_DISPLAY_MS = 2000;
const SETUP_FAILURE_REPAIR_DELAY_MS = 800;
const SETUP_FAILURE_SETUP_DELAY_MS = 900;
const QUEUED_TURN_COMPLETION_DELAY_MS = 700;

const PLATFORMS = [
  { key: "default", label: "Default" },
  { key: "macos", label: "macOS" },
  { key: "linux", label: "Linux" },
  { key: "windows", label: "Windows" },
] as const satisfies ReadonlyArray<{ key: PlatformKey; label: string }>;

const SETUP_SCRIPT = "bun install --frozen-lockfile\nbun run build";
const SETUP_FAILURE_COMMAND = "bun install --frozen-lockfile";
const SETUP_FAILURE_STATES = [
  { key: "running", label: "Running" },
  { key: "blocked", label: "Failed" },
  { key: "repairing", label: "Repairing" },
  { key: "rerunning", label: "Rerunning" },
  { key: "passed", label: "Passed" },
  { key: "continued", label: "Continued" },
] as const satisfies ReadonlyArray<{ key: SetupFailureVisibleState; label: string }>;
const OVERVIEW_ROW_CLASS = "group h-8 w-full gap-3 px-2 text-left transition-[background-color,color,transform] duration-150 ease-out active:translate-y-px motion-reduce:transform-none";

function readKey<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const value = new URLSearchParams(window.location.search).get(name);
  return values.includes(value as T) ? (value as T) : fallback;
}

function replacePrototypeUrl(variant: VariantKey, surface: SurfaceKey, scenario: ScenarioKey): void {
  const url = new URL(window.location.href);
  url.searchParams.set("projectEnvironmentPrototype", variant);
  url.searchParams.set("surface", surface);
  url.searchParams.set("scenario", scenario);
  window.history.replaceState(window.history.state, "", url);
}

function ActionStatusIcon({ state }: { readonly state: ScenarioKey | ActionRunState }) {
  if (state === "running") {
    return <LoaderCircle className="size-4 animate-spin text-primary motion-reduce:animate-none" aria-hidden />;
  }
  if (state === "unavailable") return <CircleSlash className="size-4 text-muted-foreground" aria-hidden />;
  if (state === "completed") return <CircleCheck className="size-4 text-success" aria-hidden />;
  if (state === "interrupted") return <CircleStop className="size-4 text-muted-foreground" aria-hidden />;
  return <Play className="size-4 text-muted-foreground" aria-hidden />;
}

function initialActionStates(scenario: ScenarioKey): ActionStates {
  if (scenario === "unavailable") return { web: "unavailable", tests: "unavailable" };
  if (scenario === "running" || scenario === "completed" || scenario === "interrupted") {
    return { web: scenario, tests: "idle" };
  }
  return { web: "idle", tests: "idle" };
}

function initialTerminalStates(scenario: ScenarioKey): TerminalStates {
  if (scenario === "running" || scenario === "completed" || scenario === "interrupted") {
    return { web: scenario, tests: null };
  }
  return { web: null, tests: null };
}

function FieldLabel({ children, htmlFor }: { readonly children: ReactNode; readonly htmlFor: string }) {
  return <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-muted-foreground">{children}</label>;
}

function StorageChoice({
  mode,
  onChange,
  stacked = false,
  showLegend = true,
}: {
  readonly mode: StorageMode;
  readonly onChange: (mode: StorageMode) => void;
  readonly stacked?: boolean;
  readonly showLegend?: boolean;
}) {
  return (
    <fieldset>
      <legend className={cn("mb-2 text-sm font-semibold", !showLegend && "sr-only")}>Storage</legend>
      <div className={cn("grid gap-2", !stacked && "sm:grid-cols-2")}>
        <Button
          type="button"
          variant={mode === "system" ? "secondary" : "outline"}
          size="md"
          aria-pressed={mode === "system"}
          onClick={() => onChange("system")}
          className="h-auto min-h-12 justify-start px-3 py-2 text-left"
        >
          <Settings2 className="size-4 shrink-0" aria-hidden />
          <span>
            <span className="block font-semibold">On this system</span>
            <span className="block text-xs font-normal text-muted-foreground">Private to this Project and system</span>
          </span>
        </Button>
        <Button
          type="button"
          variant={mode === "shared" ? "secondary" : "outline"}
          size="md"
          aria-pressed={mode === "shared"}
          onClick={() => onChange("shared")}
          className="h-auto min-h-12 justify-start px-3 py-2 text-left"
        >
          <FolderGit2 className="size-4 shrink-0" aria-hidden />
          <span>
            <span className="block font-semibold">Shared in `.mcode`</span>
            <span className="block text-xs font-normal text-muted-foreground">Stored in the active checkout</span>
          </span>
        </Button>
      </div>
    </fieldset>
  );
}

function StorageConfirmation({ mode, onConfirm, onCancel, repositoryCopy = false }: {
  readonly mode: StorageMode;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly repositoryCopy?: boolean;
}) {
  const shared = mode === "shared";
  const repositoryCopyContent = shared
    ? {
        title: "Save these settings in this repository?",
        description: <>Mcode creates <code className="font-mono text-foreground/80">.mcode/environment.json</code> in this checkout. Commit the file to share these settings. Shared commands require approval.</>,
        primaryAction: "Save in repository",
      }
    : {
        title: "Save these settings on this computer only?",
        description: "Mcode will store them in its private user data on this computer.",
        primaryAction: "Save on this computer",
      };
  const legacyCopyContent = shared
    ? {
        title: "Share this environment in `.mcode`?",
        description: "Mcode will store this Project environment at `.mcode/environment.json` in the active checkout. Shared commands require approval before they run.",
        primaryAction: "Share in `.mcode`",
      }
    : {
        title: "Keep this environment private on this system?",
        description: "Mcode will store this Project environment in private Project data on this system.",
        primaryAction: "Keep private",
      };
  const confirmationCopy = repositoryCopy ? repositoryCopyContent : legacyCopyContent;

  return (
    <div className="rounded-lg bg-muted px-3 py-3" role="alertdialog" aria-labelledby="storage-change-title">
      <div className="flex gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <p id="storage-change-title" className="text-sm font-semibold">{confirmationCopy.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{confirmationCopy.description}</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={onConfirm}>{confirmationCopy.primaryAction}</Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EnvironmentStorageSetting({
  mode,
  onChange,
}: {
  readonly mode: StorageMode;
  readonly onChange: (mode: StorageMode) => void;
}) {
  const shared = mode === "shared";
  return (
    <fieldset>
      <legend className="text-sm font-semibold">Environment</legend>
      <div className="mt-3 px-1 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor="environment-storage-switch" className="text-sm font-semibold">Save in this repository</label>
            <p className="mt-1 text-xs text-muted-foreground">
              {shared ? <>Saved as <code className="font-mono text-foreground/80">.mcode/environment.json</code> in this checkout.</> : "Saved in Mcode’s user data on this computer."}
            </p>
          </div>
          <Switch
            id="environment-storage-switch"
            aria-label="Save environment settings in this repository"
            checked={shared}
            onCheckedChange={(checked) => onChange(checked ? "shared" : "system")}
          />
        </div>
      </div>
    </fieldset>
  );
}

function PlatformCommandEditor({
  idPrefix,
  defaultScript,
}: {
  readonly idPrefix: string;
  readonly defaultScript: string;
}) {
  const [platform, setPlatform] = useState<PlatformKey>("default");
  const [scripts, setScripts] = useState<Record<PlatformKey, string>>({
    default: defaultScript,
    macos: "",
    linux: "",
    windows: "",
  });
  const tabRefs = useRef<Record<PlatformKey, HTMLButtonElement | null>>({
    default: null,
    macos: null,
    linux: null,
    windows: null,
  });
  const activePlatform = PLATFORMS.find((candidate) => candidate.key === platform) ?? PLATFORMS[0];
  const activeScript = scripts[platform];
  const panelId = `${idPrefix}-panel-${platform}`;
  const tabId = `${idPrefix}-tab-${platform}`;
  const textareaId = `${idPrefix}-script-${platform}`;

  const focusPlatform = (nextPlatform: PlatformKey) => {
    setPlatform(nextPlatform);
    tabRefs.current[nextPlatform]?.focus();
  };

  const movePlatform = (direction: -1 | 1) => {
    const index = PLATFORMS.findIndex((candidate) => candidate.key === platform);
    const nextIndex = (index + direction + PLATFORMS.length) % PLATFORMS.length;
    focusPlatform(PLATFORMS[nextIndex].key);
  };

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Command platform" className="flex flex-wrap gap-1 pb-1">
        {PLATFORMS.map((candidate) => {
          const selected = candidate.key === platform;
          return (
            <Button
              key={candidate.key}
              id={`${idPrefix}-tab-${candidate.key}`}
              ref={(element) => { tabRefs.current[candidate.key] = element; }}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel-${candidate.key}`}
              tabIndex={selected ? 0 : -1}
              variant={selected ? "secondary" : "ghost"}
              size="sm"
              className="motion-reduce:transition-none"
              onClick={() => setPlatform(candidate.key)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); movePlatform(1); return; }
                if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); movePlatform(-1); return; }
                if (event.key === "Home") { event.preventDefault(); event.stopPropagation(); focusPlatform("default"); return; }
                if (event.key === "End") { event.preventDefault(); event.stopPropagation(); focusPlatform("windows"); }
              }}
            >
              {candidate.label}
            </Button>
          );
        })}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId} tabIndex={0} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <Textarea
          id={textareaId}
          aria-label={`${activePlatform.label} command script`}
          value={activeScript}
          className="h-36 min-h-36 w-full resize-none font-mono text-xs"
          onChange={(event) => setScripts((current) => ({ ...current, [platform]: event.target.value }))}
        />
      </div>
    </div>
  );
}

function SetupEditor() {
  return <PlatformCommandEditor idPrefix="setup" defaultScript={SETUP_SCRIPT} />;
}

function ActionEditor() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div><FieldLabel htmlFor="action-name">Name</FieldLabel><Input id="action-name" defaultValue="Start web app" /></div>
        <div><FieldLabel htmlFor="action-shortcut">Shortcut</FieldLabel><Input id="action-shortcut" defaultValue="Ctrl+Shift+W" className="w-40 font-mono" /></div>
      </div>
      <PlatformCommandEditor idPrefix="action" defaultScript="bun run dev" />
    </div>
  );
}

function ApprovalPanel({ onApprove }: { readonly onApprove: () => void }) {
  return (
    <section className="rounded-lg bg-primary/8 p-4 ring-1 ring-primary/30" aria-labelledby="approval-title">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 id="approval-title" className="text-sm font-semibold">Approve shared Setup command</h3>
          <p className="mt-1 text-xs text-muted-foreground">This command comes from `.mcode/environment.json` in the current checkout.</p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-page px-3 py-2 font-mono text-xs text-foreground">{SETUP_SCRIPT}</pre>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={onApprove}>Approve and run</Button>
            <Button size="sm" variant="ghost">Cancel</Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function SetupFailurePanel({ onMessage }: { readonly onMessage: (message: string) => void }) {
  return (
    <section className="rounded-lg bg-destructive/8 p-4 ring-1 ring-destructive/30" aria-labelledby="setup-failed-title">
      <div className="flex items-start gap-3">
        <OctagonX className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 id="setup-failed-title" className="text-sm font-semibold">Setup failed</h3>
          <p className="mt-1 text-xs text-muted-foreground">`bun install --frozen-lockfile` exited with code 1. The first Turn is waiting.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onMessage("Agent repair Turn started")}>Fix with agent</Button>
            <Button size="sm" variant="outline" onClick={() => onMessage("Setup retry queued")}>Retry setup</Button>
            <Button size="sm" variant="ghost" onClick={() => onMessage("Recovery terminal opened")}>Open terminal</Button>
            <Button size="sm" variant="ghost" onClick={() => onMessage("Setup gate released without a pass")}>Continue without setup</Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function SetupFailureThreadBlock({
  flow,
  onAction,
}: {
  readonly flow: SetupFailureFlowState;
  readonly onAction: (action: SetupFailureAction) => void;
}) {
  const [recoveryMenuOpen, setRecoveryMenuOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const setupIsRunning = flow === "running" || flow === "rerunning" || flow === "retrying";
  const setupPassed = flow === "passed";
  const setupFailed = flow === "blocked" || flow === "repairing" || flow === "continued";
  const terminalIconClass = setupFailed
    ? "text-[var(--diff-remove)]"
    : setupIsRunning
      ? "text-primary"
      : "text-muted-foreground/70";

  return (
    <section
      className="min-w-0 max-w-full space-y-2"
      aria-label="Automatic Setup"
      aria-live="polite"
    >
      <div
        className="min-w-0 max-w-full overflow-hidden rounded-md bg-[var(--code-bg)] ring-1 ring-inset ring-border/45"
        aria-busy={setupIsRunning}
      >
        <button
          type="button"
          className="flex min-h-8 w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
          aria-expanded={transcriptOpen}
          onClick={() => setTranscriptOpen((open) => !open)}
        >
          <SquareTerminal className={cn("size-3.5 shrink-0", terminalIconClass)} aria-hidden />
          <span className="shrink-0 text-xs font-medium text-foreground/75">
            {setupIsRunning ? "Running Setup" : "Ran Setup"}
          </span>
          {!transcriptOpen ? (
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/70"
              title={SETUP_FAILURE_COMMAND}
            >
              {SETUP_FAILURE_COMMAND}
            </span>
          ) : <span className="min-w-0 flex-1" />}
          {setupIsRunning ? (
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <LoaderCircle
                className="size-3.5 animate-spin text-primary motion-reduce:animate-none"
                aria-hidden
              />
              <span className="sr-only">Setup running</span>
            </span>
          ) : null}
          {setupFailed ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-sm bg-[var(--diff-remove)]/15 px-1.5 py-px font-mono text-xs font-medium leading-4 text-[var(--diff-remove)]">
              <OctagonX className="size-3" aria-hidden />
              failed
            </span>
          ) : null}
          {setupPassed ? (
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <CircleCheck className="size-3.5 text-[var(--diff-add-strong)]" aria-hidden />
              Passed
            </span>
          ) : null}
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 motion-reduce:transition-none",
              transcriptOpen && "rotate-90",
            )}
            aria-hidden
          />
        </button>
        <AnimatedCollapsible open={transcriptOpen}>
          <div className="border-t border-border/45 px-3 py-2.5 font-mono text-xs leading-5">
            <div className="flex min-w-0 items-start gap-2">
              <span aria-hidden className="select-none text-primary/75">&gt;</span>
              <code className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/85 [overflow-wrap:anywhere]">
                {SETUP_FAILURE_COMMAND}
              </code>
            </div>
            {setupIsRunning ? (
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/75">
                {"Resolving dependencies...\nInstalling packages..."}
              </pre>
            ) : null}
            {setupFailed ? (
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-[var(--diff-remove)]">
                Setup stopped. The first Turn is waiting.
              </pre>
            ) : null}
            {setupPassed ? (
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/75">
                Setup complete.
              </pre>
            ) : null}
            {!setupIsRunning ? (
              <footer className="mt-2 flex justify-end">
                <span className="font-mono text-xs tabular-nums text-muted-foreground/70">
                  exit code {setupPassed ? "0" : "1"}
                </span>
              </footer>
            ) : null}
          </div>
        </AnimatedCollapsible>
      </div>
      {flow === "repairing" ? (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <ActionStatusIcon state="running" />
          <span>Repair Turn running</span>
        </div>
      ) : null}
      {flow === "continued" ? (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <CircleSlash className="size-4 shrink-0" aria-hidden />
          <span>Continued without Setup. The first Turn can start.</span>
        </div>
      ) : null}
      {flow === "blocked" ? (
        <div className="inline-flex pt-1">
          <Button
            type="button"
            size="sm"
            className="rounded-r-none border-r border-primary-foreground/20 focus-visible:z-10"
            onClick={() => onAction("fix")}
          >
            Fix with agent
          </Button>
          <DropdownMenu open={recoveryMenuOpen} onOpenChange={setRecoveryMenuOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  className="w-8 rounded-l-none px-0 focus-visible:z-10"
                  aria-label="More Setup recovery options"
                  aria-expanded={recoveryMenuOpen}
                >
                  <ChevronDown
                    className={cn(
                      "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                      recoveryMenuOpen && "rotate-180",
                    )}
                    aria-hidden
                  />
                </Button>
              }
            />
            <DropdownMenuContent align="start" sideOffset={4} className="w-48">
              <DropdownMenuItem
                className="text-xs"
                onClick={() => {
                  setRecoveryMenuOpen(false);
                  onAction("retry");
                }}
              >
                Retry setup
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs"
                onClick={() => {
                  setRecoveryMenuOpen(false);
                  onAction("open-terminal");
                }}
              >
                Open terminal
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs text-muted-foreground data-highlighted:text-foreground"
                onClick={() => {
                  setRecoveryMenuOpen(false);
                  onAction("continue");
                }}
              >
                Continue without setup
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </section>
  );
}

function SettingsHeader({ title, description }: { readonly title: string; readonly description: string }) {
  return (
    <header className="border-b border-border px-5 py-4 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <p className="text-xs text-muted-foreground">Mcode / Project settings / Caravan</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">{description}</p>
      </div>
    </header>
  );
}

function useWidePanelLayout() {
  const [isWide, setIsWide] = useState(() =>
    typeof window === "undefined" || window.matchMedia("(min-width: 76rem)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(min-width: 76rem)");
    const update = () => setIsWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isWide;
}

function ProjectSettingsPanel({
  pendingMode,
  mode,
  onMode,
  onConfirmMode,
  onCancelMode,
  scenario,
  onMessage,
  settingsTarget = "top",
  onClose,
}: SettingsVariantProps & { readonly onClose: () => void }) {
  const isWide = useWidePanelLayout();
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const [activeTarget, setActiveTarget] = useState<SettingsTarget>("top");
  const setupSectionRef = useRef<HTMLElement | null>(null);
  const actionsSectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setActiveTarget(settingsTarget);
    const target = settingsTarget === "setup" ? setupSectionRef.current : settingsTarget === "actions" ? actionsSectionRef.current : null;
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (!target) return;
    const timeout = window.setTimeout(() => setActiveTarget("top"), 1600);
    return () => window.clearTimeout(timeout);
  }, [settingsTarget]);

  const getMaxPanelWidth = useCallback((panel: HTMLDivElement | null) => {
    const splitWidth = panel?.parentElement?.clientWidth ?? window.innerWidth;
    return Math.max(
      PANEL_MIN_WIDTH,
      splitWidth - COMPOSER_MIN_WIDTH - PANEL_SPLIT_GAP_PX,
    );
  }, []);

  return (
    <ResizableRightPanel
      data-right-panel-root=""
      testId="prototype-project-settings-panel"
      width={panelWidth}
      minWidth={PANEL_MIN_WIDTH}
      maxWidth={`calc(100% - ${COMPOSER_MIN_WIDTH}px - ${PANEL_SPLIT_GAP_PX}px)`}
      getMaxWidth={getMaxPanelWidth}
      defaultWidth={PANEL_DEFAULT_WIDTH}
      wideWidth={PANEL_WIDE_WIDTH}
      separatorLabel="Resize panel"
      resizeEnabled={isWide}
      onWidthChange={(width) => setPanelWidth(width)}
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.getAttribute("role") === "separator" &&
          ["ArrowLeft", "ArrowRight", "Enter", " "].includes(event.key)
        ) {
          event.stopPropagation();
        }
      }}
      className="relative flex h-full min-h-0 min-w-0 shrink-0 flex-col overflow-hidden bg-background"
      style={!isWide ? { width: "100%", minWidth: 0, maxWidth: "100%" } : undefined}
    >
      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        <aside aria-label="Project settings panel navigation" data-testid="prototype-activity-rail" className="relative z-30 flex h-full w-12 shrink-0 flex-col items-stretch gap-0.5 overflow-hidden bg-background px-1.5 py-2">
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close panel" title="Close panel" className="h-8 w-8 shrink-0 text-muted-foreground/70 hover:bg-transparent hover:text-foreground">
            <PanelRight aria-hidden />
          </Button>
          <div className="relative mt-1 flex h-8 w-8 shrink-0 items-center justify-center">
            <Button variant="secondary" size="icon-xs" aria-label="Project settings" aria-current="page" aria-pressed="true" title="Project settings" className="h-8 w-8">
              <GearSettings aria-hidden />
            </Button>
            <span aria-hidden className="absolute -left-1 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
          </div>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l border-border bg-background">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-32">
            <div className="space-y-8">
              <header>
                <h1 className="text-base font-semibold">Project settings</h1>
                <p className="mt-1 text-xs text-muted-foreground">Caravan</p>
              </header>
              <EnvironmentStorageSetting mode={mode} onChange={onMode} />
              {pendingMode ? <StorageConfirmation repositoryCopy mode={pendingMode} onConfirm={onConfirmMode} onCancel={onCancelMode} /> : null}
              {scenario === "approval" ? <ApprovalPanel onApprove={() => onMessage("Shared Setup approved for this exact command")} /> : null}
              {scenario === "setup-failed" ? <SetupFailurePanel onMessage={onMessage} /> : null}
              <section ref={setupSectionRef} aria-labelledby="guided-setup" className={cn("scroll-mt-4 pt-4", activeTarget === "setup" && "rounded-md bg-primary/5 ring-1 ring-primary/35")}>
                <div className="mb-4 flex items-center justify-between gap-3"><div><h2 id="guided-setup" className="text-base font-semibold">Setup</h2><p className="mt-1 text-xs text-muted-foreground">Runs automatically only for a New worktree.</p></div><Button variant="outline" size="sm" onClick={() => onMessage("Manual Setup queued")}>Run setup</Button></div>
                <SetupEditor />
              </section>
              <section ref={actionsSectionRef} aria-labelledby="guided-actions" className={cn("scroll-mt-4 pt-4", activeTarget === "actions" && "rounded-md bg-primary/5 ring-1 ring-primary/35")}>
                <div className="mb-4 flex items-center justify-between gap-3"><div><h2 id="guided-actions" className="text-base font-semibold">Project actions</h2><p className="mt-1 text-xs text-muted-foreground">Each action uses a dedicated terminal in the active Thread.</p></div><Button variant="outline" size="sm">Add action</Button></div>
                <ActionEditor />
              </section>
            </div>
          </div>
        </div>
      </div>
    </ResizableRightPanel>
  );
}

type TerminalPanelProps =
  | { readonly kind: "action"; readonly action: ActionKey; readonly state: TerminalState; readonly onClose: () => void }
  | { readonly kind: "setup-recovery"; readonly onClose: () => void };

function TerminalPanel(props: TerminalPanelProps) {
  const isWide = useWidePanelLayout();
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const isSetupRecovery = props.kind === "setup-recovery";
  const onClose = props.onClose;
  const command = isSetupRecovery ? "bun install --frozen-lockfile" : props.action === "web" ? "bun run dev" : "bun test";
  const terminalName = isSetupRecovery ? "Setup recovery" : ACTION_LABELS[props.action];
  const state = isSetupRecovery ? "interrupted" : props.state;
  const output = isSetupRecovery
    ? `> ${command}\n\nProcess exited with code 1\n\nRecovery is waiting for a decision.`
    : state === "running"
      ? `> ${command}\n\nStarting ${terminalName}...`
      : state === "completed"
        ? props.action === "web" ? `> ${command}\n\nServer ready on http://localhost:3000` : `> ${command}\n\n2 tests passed`
        : `> ${command}\n\nProcess interrupted`;

  const getMaxPanelWidth = useCallback((panel: HTMLDivElement | null) => {
    const splitWidth = panel?.parentElement?.clientWidth ?? window.innerWidth;
    return Math.max(
      PANEL_MIN_WIDTH,
      splitWidth - COMPOSER_MIN_WIDTH - PANEL_SPLIT_GAP_PX,
    );
  }, []);

  return (
    <ResizableRightPanel
      data-right-panel-root=""
      testId="prototype-terminal-panel"
      width={panelWidth}
      minWidth={PANEL_MIN_WIDTH}
      maxWidth={`calc(100% - ${COMPOSER_MIN_WIDTH}px - ${PANEL_SPLIT_GAP_PX}px)`}
      getMaxWidth={getMaxPanelWidth}
      defaultWidth={PANEL_DEFAULT_WIDTH}
      wideWidth={PANEL_WIDE_WIDTH}
      separatorLabel="Resize panel"
      resizeEnabled={isWide}
      onWidthChange={(width) => setPanelWidth(width)}
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.getAttribute("role") === "separator" &&
          ["ArrowLeft", "ArrowRight", "Enter", " "].includes(event.key)
        ) {
          event.stopPropagation();
        }
      }}
      className="relative flex h-full min-h-0 min-w-0 shrink-0 flex-col overflow-hidden bg-background"
      style={!isWide ? { width: "100%", minWidth: 0, maxWidth: "100%" } : undefined}
    >
      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        <aside aria-label="Terminal panel navigation" data-testid="prototype-terminal-activity-rail" className="relative z-30 flex h-full w-12 shrink-0 flex-col items-stretch gap-0.5 overflow-hidden bg-background px-1.5 py-2">
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close panel" title="Close panel" className="h-8 w-8 shrink-0 text-muted-foreground/70 hover:bg-transparent hover:text-foreground">
            <PanelRight aria-hidden />
          </Button>
          <div className="relative mt-1 flex h-8 w-8 shrink-0 items-center justify-center">
            <Button variant="secondary" size="icon-xs" aria-label={`${terminalName} terminal`} aria-current="page" aria-pressed="true" title={`${terminalName} terminal`} className="h-8 w-8">
              <SquareTerminal aria-hidden />
            </Button>
            <span aria-hidden className="absolute -left-1 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
          </div>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l border-border bg-background">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-32">
            <div className="space-y-5">
              <header>
                <p className="text-xs text-muted-foreground">Terminal</p>
                <h1 className="mt-1 text-base font-semibold">{terminalName}</h1>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{command}</p>
              </header>
              <div className="rounded-md bg-page p-3 ring-1 ring-border/70">
                <div className="flex items-center gap-2 text-xs font-medium">{isSetupRecovery ? <><OctagonX className="size-4 text-destructive" aria-hidden /><span>Setup failed</span></> : <><ActionStatusIcon state={state} /><span>{state[0].toUpperCase() + state.slice(1)}</span></>}</div>
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-5 text-foreground/85">{output}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ResizableRightPanel>
  );
}

function GuidedSettings({
  mode,
  pendingMode,
  onMode,
  onConfirmMode,
  onCancelMode,
  scenario,
  onMessage,
  settingsTarget,
  onClose,
}: SettingsVariantProps & { readonly onClose: () => void }) {
  return (
    <div className="flex h-full min-h-0 bg-page">
      <main className="hidden min-w-0 flex-1 overflow-y-auto bg-page min-[76rem]:block" aria-label="Caravan workspace">
        <header className="border-b border-border px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">Caravan</p>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">feature/project-environments</p>
            </div>
            <span className="text-xs text-muted-foreground">Current Thread</span>
          </div>
        </header>
        <div className="mx-auto max-w-3xl px-6 py-10">
          <p className="text-xs font-medium text-muted-foreground">Project workspace</p>
          <h2 className="mt-2 text-lg font-semibold">Thread conversation</h2>
          <p className="mt-2 max-w-[62ch] text-sm text-muted-foreground">Project environment settings stay beside the active Thread so their scope remains visible.</p>
          <div className="mt-8 border-t border-border pt-5">
            <p className="text-sm font-medium">Agent</p>
            <p className="mt-2 text-sm text-muted-foreground">The implementation plan is ready. No files changed.</p>
          </div>
        </div>
      </main>
      <ProjectSettingsPanel mode={mode} pendingMode={pendingMode} onMode={onMode} onConfirmMode={onConfirmMode} onCancelMode={onCancelMode} scenario={scenario} onMessage={onMessage} settingsTarget={settingsTarget} onClose={onClose} />
    </div>
  );
}

function CommandInspector({
  mode,
  pendingMode,
  onMode,
  onConfirmMode,
  onCancelMode,
  scenario,
  onMessage,
}: SettingsVariantProps) {
  const [selection, setSelection] = useState<"setup" | "web" | "tests">("web");
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <SettingsHeader title="Environment commands" description="Select a command, inspect the resolved script, and edit its platform variants." />
      <div className="grid min-h-0 flex-1 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <nav aria-label="Environment commands" className="border-b border-border bg-page p-3 lg:border-r lg:border-b-0">
          <div className="mb-4"><StorageChoice mode={pendingMode ?? mode} onChange={onMode} stacked /></div>
          {pendingMode ? <StorageConfirmation mode={pendingMode} onConfirm={onConfirmMode} onCancel={onCancelMode} /> : null}
          <p className="mb-1 px-2 text-xs font-semibold text-muted-foreground">Commands</p>
          {([['setup', 'Setup', Wrench], ['web', 'Start web app', Play], ['tests', 'Run tests', Code2]] as const).map(([key, label, Icon]) => (
            <Button key={key} variant={selection === key ? "secondary" : "ghost"} size="sm" onClick={() => setSelection(key)} className="mb-1 w-full justify-start">
              <Icon className="size-4" aria-hidden />{label}{key === "web" && scenario === "running" ? <LoaderCircle className="ml-auto size-3.5 animate-spin text-primary motion-reduce:animate-none" aria-label="Running" /> : null}
            </Button>
          ))}
          <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground">Add action</Button>
        </nav>
        <main className="min-w-0 overflow-y-auto px-5 py-6 pb-32 sm:px-8">
          <div className="mx-auto max-w-3xl space-y-5">
            <div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">{selection === 'setup' ? 'Setup' : selection === 'web' ? 'Start web app' : 'Run tests'}</h2><p className="mt-1 text-xs text-muted-foreground">Resolved for Windows from the active Thread checkout.</p></div><Badge variant="outline">{selection === 'setup' ? 'Setup' : 'Action'}</Badge></div>
            {scenario === "approval" ? <ApprovalPanel onApprove={() => onMessage("Shared command approved for this exact script")} /> : null}
            {scenario === "setup-failed" && selection === "setup" ? <SetupFailurePanel onMessage={onMessage} /> : null}
            {selection === "setup" ? <SetupEditor /> : <ActionEditor />}
            <section aria-labelledby="resolved-command"><h3 id="resolved-command" className="mb-2 text-sm font-semibold">Resolved command</h3><pre className="overflow-x-auto rounded-lg bg-page p-3 font-mono text-xs">{selection === 'setup' ? SETUP_SCRIPT : selection === 'web' ? 'bun run dev' : 'bun run test'}</pre></section>
          </div>
        </main>
      </div>
    </div>
  );
}

function FilePreviewSettings({
  mode,
  pendingMode,
  onMode,
  onConfirmMode,
  onCancelMode,
  scenario,
  onMessage,
}: SettingsVariantProps) {
  const source = `{
  "version": "0.0.1",
  "setup": { "default": "bun install --frozen-lockfile" },
  "actions": [
    { "id": "web", "name": "Start web app", "default": "bun run dev" },
    { "id": "tests", "name": "Run tests", "default": "bun run test" }
  ]
}`;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <SettingsHeader title="Project environment file" description="Edit the environment document and review how it resolves for this Thread." />
      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(26rem,1fr)_minmax(22rem,0.8fr)]">
        <main className="min-h-0 overflow-y-auto border-b border-border px-5 py-6 pb-32 sm:px-8 xl:border-r xl:border-b-0">
          <div className="mx-auto max-w-3xl space-y-5">
            <StorageChoice mode={pendingMode ?? mode} onChange={onMode} />
            {pendingMode ? <StorageConfirmation mode={pendingMode} onConfirm={onConfirmMode} onCancel={onCancelMode} /> : null}
            <div><div className="mb-2 flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">{mode === 'shared' ? '.mcode/environment.json' : 'Private environment.json'}</h2><p className="mt-1 text-xs text-muted-foreground">Schema version 0.0.1</p></div><Badge variant="outline">Valid</Badge></div><Textarea aria-label="Project environment JSON" defaultValue={source} rows={15} className="min-h-80 font-mono text-xs leading-5" /></div>
            <div className="flex justify-end gap-2"><Button variant="ghost" size="sm">Format</Button><Button size="sm" onClick={() => onMessage("Environment document saved")}>Save file</Button></div>
          </div>
        </main>
        <aside className="min-h-0 overflow-y-auto bg-page px-5 py-6 pb-32 sm:px-8" aria-label="Environment preview">
          <div className="space-y-5">
            <div><h2 className="text-base font-semibold">Current Thread</h2><p className="mt-1 font-mono text-xs text-muted-foreground">C:\src\caravan\.worktrees\feature-auth</p></div>
            {scenario === "approval" ? <ApprovalPanel onApprove={() => onMessage("Shared Setup approved for this exact command")} /> : null}
            {scenario === "setup-failed" ? <SetupFailurePanel onMessage={onMessage} /> : null}
            <section aria-labelledby="preview-resolution" className="rounded-lg bg-card p-4 ring-1 ring-border"><h3 id="preview-resolution" className="text-sm font-semibold">Windows resolution</h3><dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs"><dt className="text-muted-foreground">Setup</dt><dd className="font-mono">bun install --frozen-lockfile</dd><dt className="text-muted-foreground">Actions</dt><dd>2 available</dd><dt className="text-muted-foreground">Approval</dt><dd>{mode === 'shared' ? 'Required after changes' : 'Not required'}</dd></dl></section>
          </div>
        </aside>
      </div>
    </div>
  );
}

interface SettingsVariantProps {
  readonly mode: StorageMode;
  readonly pendingMode: StorageMode | null;
  readonly onMode: (mode: StorageMode) => void;
  readonly onConfirmMode: () => void;
  readonly onCancelMode: () => void;
  readonly scenario: ScenarioKey;
  readonly onMessage: (message: string) => void;
  readonly settingsTarget?: SettingsTarget;
}

function ActionRow({
  name,
  detail,
  scenario,
  onActivate,
}: {
  readonly name: string;
  readonly detail: string;
  readonly scenario: ScenarioKey;
  readonly onActivate: () => void;
}) {
  const unavailable = scenario === "unavailable";
  const running = scenario === "running";
  const stateText = unavailable
    ? "Not available on this system"
    : running
      ? "Running · select to focus terminal"
      : scenario === "completed"
        ? "Completed · exit code 0"
        : scenario === "interrupted"
          ? "Interrupted · stopped by user"
          : detail;
  return (
    <Button
      variant="ghost"
      size="md"
      disabled={unavailable}
      onClick={onActivate}
      className="h-auto min-h-14 w-full justify-start px-3 py-2 text-left"
      aria-label={`${name}, ${stateText}`}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted"><SquareTerminal className="size-4 text-muted-foreground" aria-hidden /></span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{name}</span><span className="block truncate text-xs font-normal text-muted-foreground">{stateText}</span></span>
      <ActionStatusIcon state={scenario} />
    </Button>
  );
}

function OverviewActionRow({
  name,
  detail,
  state,
  onActivate,
}: {
  readonly name: string;
  readonly detail: string;
  readonly state: ActionRunState;
  readonly onActivate: () => void;
}) {
  const unavailable = state === "unavailable";
  const accessibleState = state === "running"
    ? "Running, select to focus terminal"
    : state === "completed"
      ? "Completed, exit code 0"
      : state === "interrupted"
        ? "Interrupted, stopped by user"
        : state === "unavailable"
          ? "Not available on this system"
          : detail;

  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      disabled={unavailable}
      onClick={onActivate}
      className={OVERVIEW_ROW_CLASS}
      aria-label={`${name}, ${accessibleState}`}
    >
      <SquareTerminal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
      <ActionStatusIcon state={state} />
    </Button>
  );
}

function TerminalOverviewRow({
  action,
  state,
  onOpen,
}: {
  readonly action: ActionKey;
  readonly state: TerminalState;
  readonly onOpen: () => void;
}) {
  const status = state[0].toUpperCase() + state.slice(1);
  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      onClick={onOpen}
      aria-label={`${ACTION_LABELS[action]} terminal, ${status}`}
      className={cn(OVERVIEW_ROW_CLASS, "justify-between")}
    >
      <span className="flex min-w-0 items-center gap-2"><SquareTerminal size={14} className="shrink-0 text-muted-foreground" aria-hidden /><span className="truncate text-xs font-medium">{ACTION_LABELS[action]}</span></span>
      <span className="flex shrink-0 items-center gap-2"><span className="text-xs text-muted-foreground">{status}</span><ActionStatusIcon state={state} /></span>
    </Button>
  );
}

function PrototypeComposer() {
  return (
    <div className="relative shrink-0 px-4 py-4 sm:px-8">
      <div className={PRIMARY_CONTENT_RAIL_CLASS}>
        <div className="rounded-xl bg-muted/50 ring-1 ring-inset ring-border/60 focus-within:ring-2 focus-within:ring-primary/70">
          <Textarea
            aria-label="Message Mcode"
            placeholder="Ask for changes"
            rows={2}
            className="min-h-20 resize-none border-0 bg-transparent px-3 py-3 text-sm shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center gap-1.5 border-t border-border/20 px-3 py-1.5">
            <Button variant="ghost" size="icon-xs" aria-label="Add context" title="Add context">
              <Plus className="size-3.5" aria-hidden />
            </Button>
            <Button variant="ghost" size="xs" className="gap-1.5 text-muted-foreground">
              <Wrench className="size-3.5" aria-hidden />
              Build
              <ChevronDown className="size-3" aria-hidden />
            </Button>
            <Button variant="ghost" size="xs" className="text-muted-foreground">Permissions</Button>
            <div className="flex-1" />
            <Button variant="ghost" size="icon-sm" disabled aria-label="Send message" title="Send message">
              <ArrowUp className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ThreadSurface({
  variant,
  scenario,
  onScenario,
  onMessage,
  projectSettingsOpen,
  onOpenProjectSettings,
  onCloseProjectSettings,
  terminalAction,
  onOpenTerminal,
  settingsProps,
  actionStates,
  terminals,
  onAction,
  setupState,
  onSetup,
  setupFailureFlow,
  queuedFirstTurnState,
  setupRecoveryTerminalOpen,
  onSetupFailureAction,
}: {
  readonly variant: VariantKey;
  readonly scenario: ScenarioKey;
  readonly onScenario: (scenario: ScenarioKey) => void;
  readonly onMessage: (message: string) => void;
  readonly projectSettingsOpen: boolean;
  readonly onOpenProjectSettings: (target?: SettingsTarget) => void;
  readonly onCloseProjectSettings: () => void;
  readonly terminalAction: ActionKey | null;
  readonly onOpenTerminal: (action: ActionKey) => void;
  readonly settingsProps: SettingsVariantProps;
  readonly actionStates: ActionStates;
  readonly terminals: TerminalStates;
  readonly onAction: (action: ActionKey) => void;
  readonly setupState: SetupRunState;
  readonly onSetup: () => void;
  readonly setupFailureFlow: SetupFailureFlowState;
  readonly queuedFirstTurnState: QueuedTurnState;
  readonly setupRecoveryTerminalOpen: boolean;
  readonly onSetupFailureAction: (action: SetupFailureAction) => void;
}) {
  const [overviewOpen, setOverviewOpen] = useState(true);
  const [actionsOpen, setActionsOpen] = useState(false);
  const rightPanelOpen = projectSettingsOpen || terminalAction !== null || setupRecoveryTerminalOpen;

  useEffect(() => {
    setOverviewOpen(!rightPanelOpen);
    setActionsOpen(false);
  }, [rightPanelOpen]);

  useEffect(() => {
    if (!overviewOpen) setActionsOpen(false);
  }, [overviewOpen]);

  const activate = () => {
    if (scenario === "running") onMessage("Start web app terminal focused");
    else { onScenario("running"); onMessage("Start web app started in a dedicated terminal"); }
  };
  return (
    <div className="flex h-full min-h-0 bg-background">
      <div className={cn("flex min-w-0 min-h-0 flex-1 flex-col", rightPanelOpen && "hidden min-[76rem]:flex")}>
        <header className="relative z-20 flex h-11 items-center justify-between border-b border-border pr-4 pl-2">
          <div className="min-w-0"><span className="truncate text-sm font-medium">Project environment settings</span></div>
          <div className="flex items-center gap-1">
            <div className="relative">
              <Button variant="ghost" size="icon-sm" aria-expanded={overviewOpen} aria-label="Overview" title="Overview" onClick={() => setOverviewOpen((open) => !open)} className={cn("text-foreground/80 hover:bg-muted/40 hover:text-foreground", overviewOpen && "bg-muted text-foreground")}><Settings2 className="size-4" aria-hidden /></Button>
              {overviewOpen ? <section aria-label="Thread overview" className={cn("absolute right-0 top-[calc(100%+0.5rem)] z-30 rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10", variant === "B" ? "w-[min(44rem,calc(100vw-2rem))] overflow-hidden" : "w-[min(30rem,calc(100vw-2rem))]", variant === "A" ? "overflow-visible" : "overflow-hidden") }>
                <div className="flex h-9 items-center justify-between gap-3 bg-muted/20 px-3">
                  <h2 className="text-xs font-semibold text-foreground/90">Overview</h2>
                  {variant === "A" ? (
                    <div className="flex items-center gap-0.5">
                      <div className="relative">
                        <Button variant="ghost" size="icon-xs" type="button" aria-expanded={actionsOpen} aria-controls="prototype-overview-actions" aria-label="Actions" title="Actions" onClick={() => setActionsOpen((open) => !open)} className={cn("text-muted-foreground hover:bg-muted/40 hover:text-foreground", actionsOpen && "bg-muted text-foreground")}><MoreHorizontal className="size-4" aria-hidden /></Button>
                        {actionsOpen ? (
                          <div id="prototype-overview-actions" className="absolute right-0 top-[calc(100%+0.25rem)] z-40 w-[min(30rem,calc(100vw-2rem))] rounded-md bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-foreground/10">
                            <p className="px-2 py-1 text-xs font-semibold">Actions</p>
                            {scenario === "setup-failed" ? <div className="flex items-center gap-2 rounded-md bg-destructive/8 px-2 py-1.5"><OctagonX className="size-3.5 shrink-0 text-destructive" aria-hidden /><span className="min-w-0 flex-1 truncate text-xs">Setup failed</span><Button size="xs" variant="ghost" onClick={() => onMessage("Setup recovery opened")}>Review</Button></div> : null}
                            {scenario === "approval" ? <div className="flex items-center gap-2 rounded-md bg-primary/8 px-2 py-1.5"><ShieldAlert className="size-3.5 shrink-0 text-primary" aria-hidden /><span className="min-w-0 flex-1 truncate text-xs">Setup approval required</span><Button size="xs" variant="ghost" onClick={() => onMessage("Exact Setup script opened for approval")}>Review</Button></div> : null}
                            <div className="mt-1 space-y-0.5">
                            <OverviewActionRow name="Start web app" detail="Ctrl+Shift+W" state={actionStates.web} onActivate={() => onAction("web")} />
                            <OverviewActionRow name="Run tests" detail="Ctrl+Shift+T" state={actionStates.tests} onActivate={() => onAction("tests")} />
                            </div>
                            <Button variant="ghost" size="sm" type="button" aria-label="Add action in Project settings" onClick={() => { setActionsOpen(false); setOverviewOpen(false); onOpenProjectSettings("actions"); }} className={cn(OVERVIEW_ROW_CLASS, "mt-0.5 justify-start")}><Plus size={14} className="shrink-0 text-muted-foreground" aria-hidden /><span className="text-xs font-medium">Add action</span></Button>
                            <Separator className="my-1.5" />
                            <Button variant="ghost" size="sm" type="button" aria-label={scenario === "setup-missing" ? "Configure setup in Project settings" : setupState === "running" ? "Setup running" : setupState === "completed" ? "Setup complete" : "Run setup"} onClick={() => { if (scenario === "setup-missing") { setActionsOpen(false); setOverviewOpen(false); onOpenProjectSettings("setup"); } else { onSetup(); } }} className={cn(OVERVIEW_ROW_CLASS, scenario === "setup-missing" ? "justify-start" : "justify-between")}><span className="flex min-w-0 items-center gap-2"><Wrench size={14} className="shrink-0 text-muted-foreground" aria-hidden /><span className="truncate text-xs font-medium">{scenario === "setup-missing" ? "Configure setup" : setupState === "running" ? "Setup running" : setupState === "completed" ? "Setup complete" : "Run setup"}</span></span>{scenario === "setup-missing" ? null : <ActionStatusIcon state={setupState} />}</Button>
                          </div>
                        ) : null}
                      </div>
                      <Button variant="ghost" size="icon-xs" type="button" aria-label="Open Project settings" title="Open Project settings" onClick={() => { setActionsOpen(false); setOverviewOpen(false); onOpenProjectSettings(); }}><GearSettings className="size-4" aria-hidden /></Button>
                    </div>
                  ) : null}
                </div>
                <Separator />
                {variant !== "A" ? <div className="space-y-2 p-4"><p className="text-xs font-medium text-muted-foreground">Selected Thread</p><p className="text-sm font-semibold">feature/project-environments</p><p className="text-xs text-muted-foreground">Caravan</p></div> : null}
                {variant === "B" ? (
                  <div className="grid sm:grid-cols-[1fr_12rem]"><div className="p-2"><p className="px-2 py-1 text-xs font-semibold">Actions</p><ActionRow name="Start web app" detail="Ctrl+Shift+W" scenario={scenario} onActivate={activate} /><ActionRow name="Run tests" detail="Ctrl+Shift+T" scenario="ready" onActivate={() => onMessage("Run tests started")} /></div><aside className="border-t border-border bg-page p-3 sm:border-t-0 sm:border-l"><p className="text-xs font-semibold">Selected action</p><p className="mt-2 text-sm">Start web app</p><p className="mt-1 font-mono text-xs text-muted-foreground">bun run dev</p>{scenario === "running" ? <div className="mt-4 flex gap-2"><Button size="sm" variant="outline" onClick={() => onMessage("Action restart waits for the stop barrier")}><RotateCw className="size-3.5" />Restart</Button><Button size="sm" variant="ghost" onClick={() => { onScenario("ready"); onMessage("Action interrupted"); }}><CircleStop className="size-3.5" />Stop</Button></div> : null}</aside></div>
                ) : variant === "A" ? (
                  <div className="px-1.5 pb-1.5">
                    <div className="space-y-0.5">
                      <Button variant="ghost" size="sm" type="button" onClick={() => onMessage("Changes opened")} aria-label="Changes, 128 additions, 24 deletions" className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-between")}>
                        <span className="flex min-w-0 items-center gap-2"><Diff size={14} className="shrink-0 text-muted-foreground" /><span className="truncate text-xs font-medium">Changes</span></span>
                        <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums"><span className="text-[var(--diff-add-strong)]">+128</span><span className="text-[var(--diff-remove-strong)]">-24</span></span>
                      </Button>
                      <div className="flex w-full flex-col gap-1.5 px-2 py-1.5">
                        <span className="font-mono text-xs font-medium uppercase leading-tight tracking-[0.18em] text-muted-foreground">REPOSITORY</span>
                        <Button variant="ghost" size="sm" type="button" onClick={() => onMessage("Repository opened")} aria-label="Open Mzeey-Empire/mcode on remote" className="-mx-1.5 h-7 min-w-0 justify-start gap-1.5 rounded-md px-1.5 text-left text-primary hover:bg-muted/50 hover:text-primary focus-visible:ring-inset">
                          <SiteFavicon src="https://github.com/favicon.ico" fallback={<GitBranch size={14} className="shrink-0 text-muted-foreground" />} />
                          <span className="truncate text-xs font-medium">Mzeey-Empire/mcode</span>
                          <ExternalLink size={12} aria-hidden className="shrink-0 text-muted-foreground" />
                        </Button>
                      </div>
                      <Button variant="ghost" size="sm" type="button" onClick={() => onMessage("Project environment settings plan opened")} aria-label="Plans, Project environment settings" className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-between")}>
                        <span className="flex min-w-0 items-center gap-2"><ListChecks size={14} className="shrink-0 text-muted-foreground" /><span className="truncate text-xs font-medium">Plans</span></span>
                        <span className="min-w-0 max-w-[11rem] truncate text-xs text-muted-foreground">Project environment settings</span>
                      </Button>
                      <Button variant="ghost" size="sm" type="button" onClick={() => onMessage("Worktree details opened")} aria-label="Worktree details" className={cn(OVERVIEW_ROW_CLASS, "justify-between")}><span className="flex min-w-0 items-center gap-2"><FolderGit2 size={14} className="shrink-0 text-muted-foreground" /><span className="truncate text-xs font-medium">Worktree</span></span><ChevronDown size={13} aria-hidden className="shrink-0 text-muted-foreground" /></Button>
                      <Button variant="ghost" size="sm" type="button" onClick={() => onMessage("Branch menu opened")} aria-label="Branch feature/project-environments" className={cn(OVERVIEW_ROW_CLASS, "justify-between")}><span className="flex min-w-0 items-center gap-2"><GitBranch size={14} className="shrink-0 text-muted-foreground" /><span className="truncate text-xs font-medium">feature/project-environments</span></span><ChevronDown size={13} aria-hidden className="shrink-0 text-muted-foreground" /></Button>
                    </div>
                    {ACTION_KEYS.some((action) => terminals[action] !== null) ? (
                      <div className="mt-1">
                        <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">Terminals</p>
                        {ACTION_KEYS.map((action) => {
                          const state = terminals[action];
                          return state ? <TerminalOverviewRow key={action} action={action} state={state} onOpen={() => onOpenTerminal(action)} /> : null;
                        })}
                      </div>
                    ) : null}
                    <div className="px-2.5 py-2.5">
                      <div className="flex min-w-0 items-center justify-between gap-2"><span className="shrink-0 text-xs font-medium text-muted-foreground">Recap</span><Button variant="ghost" size="icon-xs" type="button" aria-label="Refresh recap" title="Refresh recap" onClick={() => onMessage("Recap refreshed")}><RefreshCw size={13} aria-hidden /></Button></div>
                      <p className="mt-2 max-w-[26rem] whitespace-normal break-words text-xs leading-[1.45] text-foreground/85">Project environment settings are ready to review.</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 px-4 pb-4">
                    {scenario === "setup-failed" ? <div className="rounded-md bg-destructive/8 p-3"><p className="flex items-center gap-2 text-sm font-semibold"><OctagonX className="size-4 text-destructive" />Setup failed</p><p className="mt-1 text-xs text-muted-foreground">The first Turn is waiting.</p><Button size="sm" className="mt-3" onClick={() => onMessage("Setup recovery opened")}>Review Setup</Button></div> : null}
                    {scenario === "approval" ? <div className="rounded-md bg-primary/8 p-3"><p className="flex items-center gap-2 text-sm font-semibold"><ShieldAlert className="size-4 text-primary" />Setup approval required</p><Button size="sm" className="mt-3" onClick={() => onMessage("Exact Setup script opened for approval")}>Review command</Button></div> : null}
                    <div><h3 className="text-xs font-semibold">Actions</h3><div className="mt-1 space-y-1"><ActionRow name="Start web app" detail="Ctrl+Shift+W" scenario={scenario} onActivate={activate} /><ActionRow name="Run tests" detail="Ctrl+Shift+T" scenario="ready" onActivate={() => onMessage("Run tests started in a dedicated terminal")} /></div></div>
                    {variant === "C" ? <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => onMessage("Manual Setup queued")}><Wrench className="size-4" />Run setup</Button> : null}
                  </div>
                )}
              </section> : null}
            </div>
            <Button variant="ghost" size="icon-xs" aria-label="More Thread actions"><MoreHorizontal className="size-4" /></Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto bg-background">
          <div className={cn(PRIMARY_CONTENT_RAIL_CLASS, "space-y-8 px-4 py-8 sm:px-8") }>
            {variant === "A" && scenario === "setup-failed" ? (
              <>
                <SetupFailureThreadBlock flow={setupFailureFlow} onAction={onSetupFailureAction} />
                {queuedFirstTurnState !== "waiting" ? <div className="flex justify-end"><div className="max-w-[min(82%,56rem)] rounded-lg rounded-br-md bg-accent px-3 py-1.5 text-sm text-accent-foreground">Show me the project environment settings for this Thread.</div></div> : null}
                {queuedFirstTurnState === "completed" ? <div className="space-y-2 text-sm text-foreground"><p>The active Thread uses one Project environment document for Setup and Project actions.</p><p className="text-muted-foreground">Review the storage mode and command overrides from Overview.</p></div> : null}
              </>
            ) : (
              <>
                <div className="flex justify-end">
                  <div className="max-w-[min(82%,56rem)] rounded-lg rounded-br-md bg-accent px-3 py-1.5 text-sm text-accent-foreground">Show me the project environment settings for this Thread.</div>
                </div>
                <div className="space-y-2 text-sm text-foreground">
                  <p>The active Thread uses one Project environment document for Setup and Project actions.</p>
                  <p className="text-muted-foreground">Review the storage mode and command overrides from Overview.</p>
                </div>
              </>
            )}
          </div>
        </div>
        <PrototypeComposer />
      </div>
      {projectSettingsOpen && variant === "A" ? <ProjectSettingsPanel {...settingsProps} onClose={onCloseProjectSettings} /> : terminalAction && variant === "A" ? <TerminalPanel kind="action" action={terminalAction} state={terminals[terminalAction] ?? "completed"} onClose={onCloseProjectSettings} /> : setupRecoveryTerminalOpen && variant === "A" ? <TerminalPanel kind="setup-recovery" onClose={onCloseProjectSettings} /> : null}
    </div>
  );
}

function PrototypeShell({ children, surface, onSurface }: {
  readonly children: ReactNode;
  readonly surface: SurfaceKey;
  readonly onSurface: (surface: SurfaceKey) => void;
}) {
  return (
    <div className="flex h-screen overflow-hidden bg-page text-foreground" data-surface={surface}>
      <aside className="hidden w-72 shrink-0 flex-col bg-page sm:flex">
        <div className="flex h-11 items-center border-b border-border/40 pl-2 pr-2.5">
          <McodeLogo variant="sidebar" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="grid shrink-0 gap-0.5 px-1.5 py-2">
            <Button variant="ghost" size="sm" className="h-8 justify-start gap-2 rounded-md px-1.5 text-[13px] font-normal text-muted-foreground hover:text-foreground">
              <SquarePen className="size-4" aria-hidden />
              New thread
            </Button>
            <Button variant="ghost" size="sm" className="h-8 justify-start gap-2 rounded-md px-1.5 text-[13px] font-normal text-muted-foreground hover:text-foreground">
              <Search className="size-4" aria-hidden />
              Search threads
            </Button>
            <Button variant="ghost" size="sm" className="h-8 justify-start gap-2 rounded-md px-1.5 text-[13px] font-normal text-muted-foreground hover:text-foreground">
              <GitPullRequest className="size-4" aria-hidden />
              Pull requests
            </Button>
          </div>
          <div className="mb-1 flex items-center justify-between px-3 py-1.5">
            <span className="text-xs font-medium text-muted-foreground">Projects</span>
            <Button variant="ghost" size="icon-xs" aria-label="Add project" title="Add project" className="text-muted-foreground hover:text-foreground">
              <Plus className="size-4" aria-hidden />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
            <div>
              <Button variant="ghost" size="sm" className="h-8 w-full justify-start gap-2 rounded-md px-1.5 text-[13px] font-medium text-foreground">
                <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
                <FolderGit2 className="size-4 text-muted-foreground" aria-hidden />
                Caravan
              </Button>
              <div className="ml-5 border-l border-border/50 pl-1">
                <Button variant="secondary" size="sm" aria-current="page" onClick={() => onSurface("thread")} className="h-9 w-full justify-start gap-2 rounded-md px-2 text-left text-[13px]">
                  <span className="size-2 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
                  <span className="min-w-0 truncate">Project environment settings</span>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function PrototypeSwitcher({
  variant,
  surface,
  scenario,
  setupFailureFlow,
  onVariant,
  onSurface,
  onScenario,
  onSetupFailureState,
}: {
  readonly variant: VariantKey;
  readonly surface: SurfaceKey;
  readonly scenario: ScenarioKey;
  readonly setupFailureFlow: SetupFailureFlowState;
  readonly onVariant: (variant: VariantKey) => void;
  readonly onSurface: (surface: SurfaceKey) => void;
  readonly onScenario: (scenario: ScenarioKey) => void;
  readonly onSetupFailureState: (state: SetupFailureVisibleState) => void;
}) {
  const cycle = useCallback((direction: -1 | 1) => {
    const index = VARIANTS.findIndex((candidate) => candidate.key === variant);
    onVariant(VARIANTS[(index + direction + VARIANTS.length) % VARIANTS.length].key);
  }, [onVariant, variant]);
  const visibleSetupFailureState = setupFailureFlow === "retrying" ? "rerunning" : setupFailureFlow;
  const cycleSetupFailureState = useCallback((direction: -1 | 1) => {
    const index = SETUP_FAILURE_STATES.findIndex((candidate) => candidate.key === visibleSetupFailureState);
    const nextIndex = (index + direction + SETUP_FAILURE_STATES.length) % SETUP_FAILURE_STATES.length;
    onSetupFailureState(SETUP_FAILURE_STATES[nextIndex].key);
  }, [onSetupFailureState, visibleSetupFailureState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.closest("input, textarea, [contenteditable='true'], [role='combobox'], [role='option'], [role='listbox']") || target.isContentEditable)) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycle]);

  return (
    <div className="fixed bottom-3 left-3 z-50 max-sm:bottom-auto max-sm:left-auto max-sm:right-3 max-sm:top-14">
      <Popover>
        <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Prototype controls" title="Prototype controls" className="bg-popover text-muted-foreground shadow-sm ring-1 ring-border/60 hover:bg-accent hover:text-foreground"><Settings2 className="size-4" aria-hidden /></Button>} />
        <PopoverContent side="top" align="start" sideOffset={8} className="w-[min(20rem,calc(100vw-1rem))] p-2">
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            <Button variant="ghost" size="icon-xs" onClick={() => cycle(-1)} aria-label="Previous variant"><ArrowLeft className="size-4" /></Button>
            {VARIANTS.map((candidate) => <Button key={candidate.key} variant={variant === candidate.key ? "secondary" : "ghost"} size="sm" aria-pressed={variant === candidate.key} aria-label={`${candidate.key}, ${candidate.label}${candidate.key === "A" ? ", selected direction" : ""}`} onClick={() => onVariant(candidate.key)}>{candidate.key} · {candidate.label}{candidate.key === "A" ? <span className="ml-1 text-[10px] text-muted-foreground">Selected</span> : null}</Button>)}
            <Button variant="ghost" size="icon-xs" onClick={() => cycle(1)} aria-label="Next variant"><ArrowRight className="size-4" /></Button>
            <span className="mx-1 h-5 w-px bg-border" aria-hidden />
            <Button variant={surface === "settings" ? "secondary" : "ghost"} size="sm" onClick={() => onSurface("settings")}>Settings</Button>
            <Button variant={surface === "thread" ? "secondary" : "ghost"} size="sm" onClick={() => onSurface("thread")}>Thread menu</Button>
            <span className="sr-only" id="prototype-scenario-label">Scenario</span>
            <Select value={scenario} onValueChange={(value) => onScenario(value as ScenarioKey)}>
              <SelectTrigger aria-labelledby="prototype-scenario-label" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCENARIOS.map((candidate) => <SelectItem key={candidate.key} value={candidate.key}>{candidate.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {variant === "A" && surface === "thread" && scenario === "setup-failed" ? (
            <div className="mt-2 flex items-center justify-center gap-1.5 border-t border-border/60 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => cycleSetupFailureState(-1)}
                aria-label="Previous Setup state"
              >
                <ArrowLeft className="size-4" aria-hidden />
              </Button>
              <Select
                value={visibleSetupFailureState}
                onValueChange={(value) => onSetupFailureState(value as SetupFailureVisibleState)}
              >
                <SelectTrigger aria-label="Setup state" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SETUP_FAILURE_STATES.map((candidate) => (
                    <SelectItem key={candidate.key} value={candidate.key}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => cycleSetupFailureState(1)}
                aria-label="Next Setup state"
              >
                <ArrowRight className="size-4" aria-hidden />
              </Button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Throwaway, development-only UI variants for Wayfinder ticket 1256. */
export function ProjectEnvironmentPrototype() {
  const [variant, setVariant] = useState<VariantKey>(() => readKey("projectEnvironmentPrototype", VARIANTS.map((item) => item.key), "A"));
  const [surface, setSurface] = useState<SurfaceKey>(() => readKey("surface", ["settings", "thread"], "settings"));
  const [scenario, setScenario] = useState<ScenarioKey>(() => readKey("scenario", SCENARIOS.map((item) => item.key), "ready"));
  const [mode, setMode] = useState<StorageMode>("system");
  const [pendingMode, setPendingMode] = useState<StorageMode | null>(null);
  const [threadProjectSettingsOpen, setThreadProjectSettingsOpen] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget>("top");
  const [actionStates, setActionStates] = useState<ActionStates>(() => initialActionStates(scenario));
  const [terminals, setTerminals] = useState<TerminalStates>(() => initialTerminalStates(scenario));
  const [setupState, setSetupState] = useState<SetupRunState>("idle");
  const actionTimersRef = useRef<Partial<Record<ActionKey, number>>>({});
  const setupTimerRef = useRef<number | null>(null);
  const setupFailureTimersRef = useRef<number[]>([]);
  const [setupFailureFlow, setSetupFailureFlow] = useState<SetupFailureFlowState>("blocked");
  const [queuedFirstTurnState, setQueuedFirstTurnState] = useState<QueuedTurnState>("waiting");
  const [setupRecoveryTerminalOpen, setSetupRecoveryTerminalOpen] = useState(false);
  const [threadTerminalAction, setThreadTerminalAction] = useState<ActionKey | null>(null);
  const [message, setMessage] = useState("Prototype ready");

  useEffect(() => replacePrototypeUrl(variant, surface, scenario), [scenario, surface, variant]);
  useEffect(() => {
    if (surface !== "thread" || variant !== "A") {
      setThreadProjectSettingsOpen(false);
      setThreadTerminalAction(null);
      setSetupRecoveryTerminalOpen(false);
    }
  }, [surface, variant]);

  const clearSetupFailureTimers = useCallback(() => {
    for (const timer of setupFailureTimersRef.current) window.clearTimeout(timer);
    setupFailureTimersRef.current = [];
  }, []);

  const clearPrototypeTimers = useCallback(() => {
    for (const action of ACTION_KEYS) {
      const timer = actionTimersRef.current[action];
      if (timer !== undefined) window.clearTimeout(timer);
      delete actionTimersRef.current[action];
    }
    if (setupTimerRef.current !== null) window.clearTimeout(setupTimerRef.current);
    setupTimerRef.current = null;
    clearSetupFailureTimers();
  }, [clearSetupFailureTimers]);

  useEffect(() => {
    clearPrototypeTimers();
    setActionStates(initialActionStates(scenario));
    setTerminals(initialTerminalStates(scenario));
    setThreadTerminalAction(null);
    setSetupFailureFlow("blocked");
    setQueuedFirstTurnState("waiting");
    setSetupRecoveryTerminalOpen(false);
    setSetupState("idle");
    return clearPrototypeTimers;
  }, [clearPrototypeTimers, scenario]);

  const onAction = useCallback((action: ActionKey) => {
    const currentState = actionStates[action];
    const label = ACTION_LABELS[action];
    if (currentState === "unavailable") return;
    if (currentState === "running") {
      setThreadProjectSettingsOpen(false);
      setThreadTerminalAction(action);
      setMessage(`${label} terminal focused`);
      return;
    }
    const existingTimer = actionTimersRef.current[action];
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    setActionStates((current) => ({ ...current, [action]: "running" }));
    setTerminals((current) => ({ ...current, [action]: "running" }));
    setMessage(`${label} running`);
    actionTimersRef.current[action] = window.setTimeout(() => {
      setActionStates((current) => ({ ...current, [action]: "completed" }));
      setTerminals((current) => ({ ...current, [action]: "completed" }));
      setMessage(`${label} completed`);
      actionTimersRef.current[action] = window.setTimeout(() => {
        setActionStates((current) => ({ ...current, [action]: "idle" }));
        delete actionTimersRef.current[action];
      }, ACTION_COMPLETED_DISPLAY_MS);
    }, ACTION_COMPLETION_DELAY_MS);
  }, [actionStates]);

  const onSetup = useCallback(() => {
    if (setupState === "running") {
      setMessage("Setup terminal focused");
      return;
    }
    if (setupTimerRef.current !== null) window.clearTimeout(setupTimerRef.current);
    setSetupState("running");
    setMessage("Setup running");
    setupTimerRef.current = window.setTimeout(() => {
      setSetupState("completed");
      setMessage("Setup complete");
      setupTimerRef.current = null;
    }, ACTION_COMPLETION_DELAY_MS);
  }, [setupState]);

  const onSetupFailureAction = useCallback((action: SetupFailureAction) => {
    if (scenario !== "setup-failed" || setupFailureFlow !== "blocked") return;
    const schedule = (callback: () => void, delay: number) => {
      const timer = window.setTimeout(() => {
        setupFailureTimersRef.current = setupFailureTimersRef.current.filter((candidate) => candidate !== timer);
        callback();
      }, delay);
      setupFailureTimersRef.current.push(timer);
    };

    if (action === "open-terminal") {
      setThreadProjectSettingsOpen(false);
      setThreadTerminalAction(null);
      setSetupRecoveryTerminalOpen(true);
      setMessage("Setup recovery terminal opened");
      return;
    }

    if (action === "continue") {
      setSetupFailureFlow("continued");
      setQueuedFirstTurnState("completed");
      setMessage("Setup gate released without a pass; queued first Turn completed");
      return;
    }

    if (action === "fix") {
      setSetupFailureFlow("repairing");
      setMessage("Repair Turn running");
      schedule(() => {
        setSetupFailureFlow("rerunning");
        setMessage("Repair Turn completed; Setup rerunning once");
      }, SETUP_FAILURE_REPAIR_DELAY_MS);
    } else {
      setSetupFailureFlow("retrying");
      setMessage("Setup retry running");
    }

    const setupPassDelay = action === "fix" ? SETUP_FAILURE_REPAIR_DELAY_MS + SETUP_FAILURE_SETUP_DELAY_MS : SETUP_FAILURE_SETUP_DELAY_MS;
    schedule(() => {
      setSetupFailureFlow("passed");
      setQueuedFirstTurnState("running");
      setMessage("Setup passed; queued first Turn started");
    }, setupPassDelay);
    schedule(() => {
      setQueuedFirstTurnState("completed");
      setMessage("Queued first Turn completed");
    }, setupPassDelay + QUEUED_TURN_COMPLETION_DELAY_MS);
  }, [scenario, setupFailureFlow]);

  const selectSetupFailureState = useCallback((state: SetupFailureVisibleState) => {
    clearSetupFailureTimers();
    setSetupFailureFlow(state);
    setQueuedFirstTurnState(state === "passed" || state === "continued" ? "completed" : "waiting");
    const label = SETUP_FAILURE_STATES.find((candidate) => candidate.key === state)?.label ?? state;
    setMessage(`Setup state: ${label}`);
  }, [clearSetupFailureTimers]);

  const openThreadSettings = useCallback((target: SettingsTarget = "top") => {
    setSettingsTarget(target);
    setThreadTerminalAction(null);
    setSetupRecoveryTerminalOpen(false);
    setThreadProjectSettingsOpen(true);
  }, []);

  const openThreadTerminal = useCallback((action: ActionKey) => {
    setThreadProjectSettingsOpen(false);
    setSetupRecoveryTerminalOpen(false);
    setThreadTerminalAction(action);
  }, []);

  const closeThreadPanel = useCallback(() => {
    setThreadProjectSettingsOpen(false);
    setThreadTerminalAction(null);
    setSetupRecoveryTerminalOpen(false);
  }, []);

  const setPrototypeSurface = useCallback((nextSurface: SurfaceKey) => {
    if (nextSurface === "settings") setSettingsTarget("top");
    if (nextSurface === "thread") {
      setThreadProjectSettingsOpen(false);
      setThreadTerminalAction(null);
      setSetupRecoveryTerminalOpen(false);
    }
    setSurface(nextSurface);
  }, []);

  const settingsProps = useMemo<SettingsVariantProps>(() => ({
    mode,
    pendingMode,
    scenario,
    settingsTarget,
    onMode: (next) => { if (next !== mode) setPendingMode(next); },
    onConfirmMode: () => { if (pendingMode) { setMode(pendingMode); setMessage(pendingMode === "shared" ? "Saved in repository" : "Saved on this computer"); } setPendingMode(null); },
    onCancelMode: () => setPendingMode(null),
    onMessage: setMessage,
  }), [mode, pendingMode, scenario, settingsTarget]);

  const settings = variant === "A" ? <GuidedSettings {...settingsProps} onClose={() => setPrototypeSurface("thread")} /> : variant === "B" ? <CommandInspector {...settingsProps} /> : <FilePreviewSettings {...settingsProps} />;

  return (
    <>
      <PrototypeShell surface={surface} onSurface={setPrototypeSurface}>
        {surface === "settings" ? settings : <ThreadSurface
          variant={variant}
          scenario={scenario}
          onScenario={setScenario}
          onMessage={setMessage}
          projectSettingsOpen={threadProjectSettingsOpen}
          onOpenProjectSettings={openThreadSettings}
          onCloseProjectSettings={closeThreadPanel}
          terminalAction={threadTerminalAction}
          onOpenTerminal={openThreadTerminal}
          settingsProps={settingsProps}
          actionStates={actionStates}
          terminals={terminals}
          onAction={onAction}
          setupState={setupState}
          onSetup={onSetup}
          setupFailureFlow={setupFailureFlow}
          queuedFirstTurnState={queuedFirstTurnState}
          setupRecoveryTerminalOpen={setupRecoveryTerminalOpen}
          onSetupFailureAction={onSetupFailureAction}
        />}
      </PrototypeShell>
      <PrototypeSwitcher
        variant={variant}
        surface={surface}
        scenario={scenario}
        setupFailureFlow={setupFailureFlow}
        onVariant={setVariant}
        onSurface={setPrototypeSurface}
        onScenario={setScenario}
        onSetupFailureState={selectSetupFailureState}
      />
      <p className="sr-only" role="status" aria-live="polite">{message}</p>
    </>
  );
}
