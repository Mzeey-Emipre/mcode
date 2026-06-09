/**
 * THROWAWAY PROTOTYPE — right-panel revamp (ADR-0004). NOT production code.
 *
 * Question it answers: what should the revamped right panel look and feel like —
 * empty-state as a quiet list vs a card grid, the tab-strip treatment, the
 * dynamic "+" menu (scope-filter then cardinality-filter), and the split
 * "open-in" button. Three structurally-different variants switch via ?variant=.
 *
 * Run:  bun run dev:web   →   http://localhost:5173/?prototype=panel
 * Toggle the threadless/thread scope with the prototype control to feel the
 * availability rules. Fold the winner into the real panel, then delete this file.
 *
 * Deliberately self-contained: no real zustand stores, no Electron, in-memory state.
 */
import { useCallback, useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Globe,
  Terminal as TerminalIcon,
  Diff,
  Files as FilesIcon,
  ListChecks,
  Plus,
  X,
  ChevronDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Github,
  SquareTerminal,
  FolderOpen,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

type TabId = "browser" | "terminal" | "review" | "files" | "scope";
type Scope = "threadless" | "thread";
type VariantKey = "A" | "B" | "C";

interface TabMeta {
  readonly id: TabId;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Pre-formatted mcode keycap; empty for types without a binding yet (Files). */
  readonly keycap: string;
  /** Only creatable once a thread exists (Review + Scope per the prototype brief). */
  readonly needsThread: boolean;
  readonly blurb: string;
  /** Shown as a disabled teaser, not yet openable (Files is a deferred feature). */
  readonly comingSoon?: boolean;
}

const TABS: readonly TabMeta[] = [
  { id: "browser", label: "Browser", icon: Globe, keycap: "Ctrl ⇧ B", needsThread: false, blurb: "Open a website" },
  { id: "terminal", label: "Terminal", icon: TerminalIcon, keycap: "Ctrl J", needsThread: false, blurb: "Start a shell" },
  { id: "files", label: "Files", icon: FilesIcon, keycap: "", needsThread: false, blurb: "Browse project files", comingSoon: true },
  { id: "review", label: "Review", icon: Diff, keycap: "Ctrl D", needsThread: true, blurb: "View code changes" },
  { id: "scope", label: "Scope", icon: ListChecks, keycap: "Ctrl T", needsThread: true, blurb: "Plan and tasks" },
];

// Stand-in for the active page's favicon. In the real panel the Browser tab's
// rail glyph is the active preview tab's favicon, with the globe as the
// blank/new-tab fallback.
const MOCK_FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%234f9eff'/%3E%3Ctext x='8' y='12' font-size='11' font-family='sans-serif' text-anchor='middle' fill='white'%3EM%3C/text%3E%3C/svg%3E";

const VARIANT_NAMES: Record<VariantKey, string> = {
  A: "Quiet list",
  B: "Card grid",
  C: "Activity rail",
};

interface OpenInApp {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

const OPEN_IN_APPS: readonly OpenInApp[] = [
  { id: "code", label: "VS Code", icon: Code2 },
  { id: "zed", label: "Zed", icon: Zap },
  { id: "github", label: "GitHub Desktop", icon: Github },
  { id: "gitbash", label: "Git Bash", icon: SquareTerminal },
  { id: "explorer", label: "File Explorer", icon: FolderOpen },
];

/** Small keycap chip; renders nothing when the binding is still pending. */
function Kbd({ value }: { value: string }) {
  if (!value) return null;
  return (
    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {value}
    </kbd>
  );
}

/** "Soon" tag for tab types that aren't openable yet (deferred features). */
function SoonBadge() {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
      Soon
    </span>
  );
}

/** Live availability + open-tab model shared by every variant. */
interface PanelModel {
  readonly scope: Scope;
  readonly openTabs: readonly TabId[];
  readonly activeTab: TabId | null;
  /** Types displayed (scope-filtered, not open) — includes coming-soon teasers. */
  readonly shown: readonly TabMeta[];
  /** Openable subset of `shown` (excludes coming-soon) — drives the "+" behavior. */
  readonly available: readonly TabMeta[];
  readonly openTab: (id: TabId) => void;
  readonly closeTab: (id: TabId) => void;
  readonly setActive: (id: TabId) => void;
}

function usePanelModel(): PanelModel & { setScope: (s: Scope) => void; reset: () => void } {
  const [scope, setScopeRaw] = useState<Scope>("threadless");
  const [openTabs, setOpenTabs] = useState<readonly TabId[]>([]);
  const [activeTab, setActiveTab] = useState<TabId | null>(null);

  const creatableInScope = useCallback(
    (id: TabId) => {
      const meta = TABS.find((t) => t.id === id);
      if (!meta) return false;
      return scope === "thread" || !meta.needsThread;
    },
    [scope],
  );

  const openTab = useCallback(
    (id: TabId) => {
      setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setActiveTab(id);
    },
    [],
  );

  const closeTab = useCallback(
    (id: TabId) => {
      setOpenTabs((prev) => {
        const next = prev.filter((t) => t !== id);
        setActiveTab((cur) => (cur === id ? next[next.length - 1] ?? null : cur));
        return next;
      });
    },
    [],
  );

  const setScope = useCallback((s: Scope) => {
    setScopeRaw(s);
    // Tabs that need a thread drop when we go threadless — demonstrates rebinding.
    setOpenTabs((prev) => {
      const next = prev.filter((id) => {
        const meta = TABS.find((t) => t.id === id);
        return s === "thread" || !meta?.needsThread;
      });
      setActiveTab((cur) => (cur && next.includes(cur) ? cur : next[next.length - 1] ?? null));
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setOpenTabs([]);
    setActiveTab(null);
  }, []);

  const shown = TABS.filter((t) => creatableInScope(t.id) && !openTabs.includes(t.id));
  const available = shown.filter((t) => !t.comingSoon);

  return { scope, openTabs, activeTab, shown, available, openTab, closeTab, setActive: setActiveTab, setScope, reset };
}

/**
 * The dynamic "+" affordance: hidden when nothing is creatable, opens the one
 * remaining type directly when exactly one is, otherwise shows a menu.
 */
function AddAffordance({
  available,
  shown,
  onCreate,
  iconOnly,
}: {
  available: readonly TabMeta[];
  shown: readonly TabMeta[];
  onCreate: (id: TabId) => void;
  iconOnly?: boolean;
}) {
  // Nothing openable hides the "+" entirely, even if a coming-soon teaser remains.
  if (available.length === 0) return null;

  // Exactly one creatable type and nothing else to show opens it directly, no menu.
  if (available.length === 1 && shown.length === 1) {
    const only = available[0];
    return (
      <Button
        variant="ghost"
        size="xs"
        className="h-7 gap-1 text-muted-foreground hover:text-foreground"
        title={`New ${only.label}`}
        onClick={() => onCreate(only.id)}
      >
        <Plus size={14} />
        {!iconOnly && <span className="text-xs">{only.label}</span>}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="h-7 gap-1 text-muted-foreground hover:text-foreground"
            title="New tab"
          >
            <Plus size={14} />
          </Button>
        }
      />
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-[180px]">
        {shown.map((t) => (
          <DropdownMenuItem
            key={t.id}
            disabled={t.comingSoon}
            onClick={t.comingSoon ? undefined : () => onCreate(t.id)}
            className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs data-[disabled]:opacity-60"
          >
            <span className="flex items-center gap-2">
              <t.icon size={14} className="text-muted-foreground" />
              {t.label}
            </span>
            {t.comingSoon ? <SoonBadge /> : <Kbd value={t.keycap} />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Split "open-in" button: default app icon + caret menu (icon + name). */
function OpenInSplitButton() {
  const [defaultId, setDefaultId] = useState<string>("code");
  const current = OPEN_IN_APPS.find((a) => a.id === defaultId) ?? OPEN_IN_APPS[0];
  const Icon = current.icon;
  return (
    <div className="flex items-center">
      <Button
        variant="ghost"
        size="xs"
        className="h-7 rounded-r-none px-2 text-muted-foreground hover:text-foreground"
        title={`Open in ${current.label}  ·  Ctrl O`}
      >
        <Icon size={14} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              className="h-7 rounded-l-none border-l border-border px-1 text-muted-foreground hover:text-foreground"
              title="Choose app"
            >
              <ChevronDown size={12} />
            </Button>
          }
        />
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-[180px]">
          {OPEN_IN_APPS.map((a) => (
            <DropdownMenuItem
              key={a.id}
              onClick={() => setDefaultId(a.id)}
              className="flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-xs"
            >
              <span className="flex items-center gap-2">
                <a.icon size={14} className="text-muted-foreground" />
                {a.label}
              </span>
              {a.id === defaultId && <Check size={13} className="text-primary" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <div className="px-3 py-1 text-[10px] text-muted-foreground">Sets this thread's default</div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Placeholder body for an open tab. */
function TabBody({ id }: { id: TabId }) {
  const meta = TABS.find((t) => t.id === id);
  if (!meta) return null;
  const Icon = meta.icon;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <Icon size={28} className="opacity-60" />
      <div className="text-sm font-medium text-foreground/80">{meta.label}</div>
      <div className="text-xs">{meta.blurb}</div>
    </div>
  );
}

/* ── Variant A — Quiet list ─────────────────────────────────────────────── */
function VariantA({ model }: { model: PanelModel }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1.5">
        {model.openTabs.map((id) => {
          const meta = TABS.find((t) => t.id === id);
          if (!meta) return null;
          const active = id === model.activeTab;
          return (
            <button
              key={id}
              onClick={() => model.setActive(id)}
              className={`group relative flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground/80"
              }`}
            >
              <meta.icon size={13} />
              {meta.label}
              {active && <span className="absolute inset-x-1 -bottom-[7px] h-0.5 rounded bg-primary" />}
              <X
                size={12}
                className="ml-0.5 opacity-0 transition group-hover:opacity-60 hover:!opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  model.closeTab(id);
                }}
              />
            </button>
          );
        })}
        {model.openTabs.length > 0 && (
          <AddAffordance available={model.available} shown={model.shown} onCreate={model.openTab} />
        )}
        <div className="ml-auto">
          <OpenInSplitButton />
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {model.activeTab ? (
          <TabBody id={model.activeTab} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="flex w-56 flex-col gap-0.5">
              {model.shown.map((t) => (
                <button
                  key={t.id}
                  disabled={t.comingSoon}
                  onClick={t.comingSoon ? undefined : () => model.openTab(t.id)}
                  className={`flex items-center justify-between rounded px-3 py-2 text-left text-sm text-muted-foreground transition ${
                    t.comingSoon ? "cursor-default opacity-50" : "hover:bg-muted/40 hover:text-foreground"
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <t.icon size={15} className="opacity-70" />
                    {t.label}
                  </span>
                  {t.comingSoon ? <SoonBadge /> : <Kbd value={t.keycap} />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Variant B — Card grid ──────────────────────────────────────────────── */
function VariantB({ model }: { model: PanelModel }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-2 py-2">
        {model.openTabs.map((id) => {
          const meta = TABS.find((t) => t.id === id);
          if (!meta) return null;
          const active = id === model.activeTab;
          return (
            <button
              key={id}
              onClick={() => model.setActive(id)}
              className={`group flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
                active
                  ? "border-primary/60 bg-card text-foreground"
                  : "border-border bg-transparent text-muted-foreground hover:bg-card/60"
              }`}
            >
              <meta.icon size={13} />
              {meta.label}
              <X
                size={12}
                className="opacity-0 transition group-hover:opacity-60 hover:!opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  model.closeTab(id);
                }}
              />
            </button>
          );
        })}
        {model.openTabs.length > 0 && (
          <AddAffordance available={model.available} shown={model.shown} onCreate={model.openTab} />
        )}
        <div className="ml-auto">
          <OpenInSplitButton />
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {model.activeTab ? (
          <TabBody id={model.activeTab} />
        ) : (
          <div className="grid h-full grid-cols-2 content-center gap-3 p-6">
            {model.shown.map((t) => (
              <button
                key={t.id}
                disabled={t.comingSoon}
                onClick={t.comingSoon ? undefined : () => model.openTab(t.id)}
                className={`flex flex-col items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-center transition ${
                  t.comingSoon ? "cursor-default opacity-50" : "hover:border-primary/50 hover:bg-card/80"
                }`}
              >
                <t.icon size={22} className="text-muted-foreground" />
                <div className="text-sm font-medium text-foreground">{t.label}</div>
                <div className="text-xs text-muted-foreground">{t.blurb}</div>
                {t.comingSoon ? <SoonBadge /> : <Kbd value={t.keycap} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Variant C — Activity rail ──────────────────────────────────────────── */
function VariantC({ model }: { model: PanelModel }) {
  return (
    <div className="flex h-full">
      <div className="flex w-12 flex-col items-center gap-1 border-r border-border/60 py-2">
        {model.openTabs.map((id) => {
          const meta = TABS.find((t) => t.id === id);
          if (!meta) return null;
          const active = id === model.activeTab;
          return (
            <button
              key={id}
              onClick={() => model.setActive(id)}
              title={meta.label}
              className={`group relative flex h-9 w-9 items-center justify-center rounded-md ${
                active ? "bg-card text-foreground" : "text-muted-foreground hover:bg-card/60"
              }`}
            >
              {meta.id === "browser" ? (
                <img src={MOCK_FAVICON} alt="" className="h-4 w-4 rounded-[3px]" />
              ) : (
                <meta.icon size={16} />
              )}
              {active && <span className="absolute -left-2 h-5 w-0.5 rounded bg-primary" />}
              <X
                size={11}
                className="absolute -right-1 -top-1 rounded-full bg-background p-[1px] text-muted-foreground opacity-0 ring-1 ring-border transition group-hover:opacity-100 hover:!text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  model.closeTab(id);
                }}
              />
            </button>
          );
        })}
        {model.openTabs.length > 0 && (
          <div className="mt-1">
            <AddAffordance available={model.available} shown={model.shown} onCreate={model.openTab} iconOnly />
          </div>
        )}
        <div className="mt-auto">
          <OpenInSplitButton />
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {model.activeTab ? (
          <TabBody id={model.activeTab} />
        ) : (
          <div className="grid h-full grid-cols-2 content-center gap-3 overflow-y-auto p-6">
            {model.shown.map((t) => (
              <button
                key={t.id}
                disabled={t.comingSoon}
                onClick={t.comingSoon ? undefined : () => model.openTab(t.id)}
                className={`flex flex-col items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-center transition ${
                  t.comingSoon ? "cursor-default opacity-50" : "hover:border-primary/50 hover:bg-card/80"
                }`}
              >
                <t.icon size={22} className="text-muted-foreground" />
                <div className="text-sm font-medium text-foreground">{t.label}</div>
                <div className="text-xs text-muted-foreground">{t.blurb}</div>
                {t.comingSoon ? <SoonBadge /> : <Kbd value={t.keycap} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Floating variant switcher. Hidden in production builds. */
function Switcher({ current, onCycle }: { current: VariantKey; onCycle: (dir: 1 | -1) => void }) {
  if (import.meta.env.PROD) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/15 bg-black/80 px-3 py-1.5 text-white shadow-lg backdrop-blur">
      <button onClick={() => onCycle(-1)} className="rounded p-1 hover:bg-white/10" title="Previous (←)">
        <ChevronLeft size={16} />
      </button>
      <span className="min-w-[140px] text-center text-xs font-medium">
        {current} — {VARIANT_NAMES[current]}
      </span>
      <button onClick={() => onCycle(1)} className="rounded p-1 hover:bg-white/10" title="Next (→)">
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

const ORDER: readonly VariantKey[] = ["A", "B", "C"];
const STORAGE_KEY = "proto-variant";

function coerce(v: string | null): VariantKey | null {
  return v === "A" || v === "B" || v === "C" ? v : null;
}

// The app reloads once on boot to set the dev ?token=, which drops our ?variant=.
// Seed storage from the URL at module-eval time (before that reload) so direct
// ?variant= links win; storage then carries the choice across the reload.
(() => {
  const fromUrl = coerce(new URLSearchParams(window.location.search).get("variant"));
  if (fromUrl) sessionStorage.setItem(STORAGE_KEY, fromUrl);
})();

function readVariant(): VariantKey {
  return coerce(sessionStorage.getItem(STORAGE_KEY)) ?? "A";
}

/**
 * Throwaway prototype surface for the right-panel revamp. Mounted by App when
 * `?prototype=panel` is present. Compare empty-state and tab-strip treatments
 * across three variants; toggle scope to feel the availability rules.
 */
export function RightPanelPrototype() {
  const [variant, setVariant] = useState<VariantKey>(readVariant);
  const model = usePanelModel();

  // The revamp targets the dark Whisper aesthetic; force it on regardless of the
  // user's theme so the prototype is judged in its intended palette. Throwaway.
  useEffect(() => {
    const html = document.documentElement;
    const had = html.classList.contains("dark");
    html.classList.add("dark");
    return () => {
      if (!had) html.classList.remove("dark");
    };
  }, []);

  const cycle = useCallback((dir: 1 | -1) => {
    setVariant((cur) => {
      const next = ORDER[(ORDER.indexOf(cur) + dir + ORDER.length) % ORDER.length];
      sessionStorage.setItem(STORAGE_KEY, next);
      const url = new URL(window.location.href);
      url.searchParams.set("prototype", "panel");
      url.searchParams.set("variant", next);
      window.history.replaceState(null, "", url);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable)) {
        return;
      }
      if (e.key === "ArrowLeft") cycle(-1);
      if (e.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle]);

  return (
    <div className="flex h-screen flex-col bg-page text-foreground">
      {/* Prototype scaffolding — clearly not part of the design under evaluation. */}
      <div className="flex items-center gap-3 border-b border-border bg-background px-4 py-2 text-xs">
        <span className="font-semibold text-foreground/80">Right-panel prototype</span>
        <span className="text-muted-foreground">scope:</span>
        {(["threadless", "thread"] as const).map((s) => (
          <button
            key={s}
            onClick={() => model.setScope(s)}
            className={`rounded px-2 py-0.5 ${
              model.scope === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            }`}
          >
            {s === "threadless" ? "No thread" : "Thread open"}
          </button>
        ))}
        <button onClick={model.reset} className="ml-2 rounded bg-muted px-2 py-0.5 text-muted-foreground hover:text-foreground">
          Reset tabs
        </button>
        <span className="ml-auto text-muted-foreground">
          {model.openTabs.length} open · {model.available.length} creatable
        </span>
      </div>

      {/* The panel surface, centered against page chrome like the real layout. */}
      <div className="flex flex-1 justify-end overflow-hidden p-1.5">
        <div className="flex h-full w-[440px] overflow-hidden rounded-lg bg-background shadow-sm">
          <div className="flex-1">
            {variant === "A" && <VariantA model={model} />}
            {variant === "B" && <VariantB model={model} />}
            {variant === "C" && <VariantC model={model} />}
          </div>
        </div>
      </div>

      <Switcher current={variant} onCycle={cycle} />
    </div>
  );
}
