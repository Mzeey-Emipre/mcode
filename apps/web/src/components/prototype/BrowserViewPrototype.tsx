/**
 * THROWAWAY PROTOTYPE — browser view for the revamped right panel. NOT production.
 *
 * Question: what does the in-app Browser view look like now that pages are no
 * longer top-level panel tabs — the clean URL header and its states (empty →
 * focused → loaded), the hover affordances, the overflow menu, and the
 * localhost-ports empty state.
 *
 * Run:  bun run dev:web  →  http://localhost:5173/?prototype=browser
 * Use the state switcher (Empty / Focused / Loaded + Hover) to see each header
 * state. Fold the winner into the real preview panel, then delete this file.
 */
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  EllipsisVertical,
  ArrowUpRight,
  PencilRuler,
  Camera,
  SquareDashedMousePointer,
  Monitor,
  Scroll,
  Paperclip,
  X,
  Plus,
  Minus,
  Smartphone,
  Code2,
  FileText,
  SlidersHorizontal,
  Cookie,
  Trash2,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

type ViewState = "empty" | "focused" | "loaded";

interface LocalPort {
  readonly name: string;
  readonly port: number;
  readonly online: boolean;
}

const LOCAL_PORTS: readonly LocalPort[] = [
  { name: "Mcode", port: 5173, online: true },
  { name: "Storybook", port: 6006, online: true },
  { name: "API", port: 19400, online: false },
];

const PAGE = { title: "google.com", url: "https://google.com" };

/** Square icon button used across the browser header. */
function IconBtn({
  icon: Icon,
  title,
  disabled,
  onClick,
}: {
  icon: typeof Globe;
  title: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-30"
    >
      <Icon size={15} />
    </Button>
  );
}

/** "Soon" tag for menu items that aren't wired yet. */
function SoonTag() {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
      Soon
    </span>
  );
}

/** The kebab overflow: the rarely-needed tools, hidden until summoned. */
function OverflowMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-xs" title="More" className="h-7 w-7 text-muted-foreground hover:text-foreground">
            <EllipsisVertical size={15} />
          </Button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-[200px]">
        <DropdownMenuItem className="gap-2 px-3 py-1.5 text-xs">
          <Plus size={14} className="text-muted-foreground" /> New page
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2 px-3 py-1.5 text-xs">
          <RotateCw size={14} className="text-muted-foreground" /> Force reload
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2 px-3 py-1.5 text-xs">
          <FileText size={14} className="text-muted-foreground" /> Dump page content
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2 px-3 py-1.5 text-xs">
          <SquareDashedMousePointer size={14} className="text-muted-foreground" /> Region capture
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
          <span className="flex items-center gap-2">
            <Code2 size={14} className="text-muted-foreground" /> Developer tools
          </span>
          <SoonTag />
        </DropdownMenuItem>
        <DropdownMenuItem disabled className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
          <span className="flex items-center gap-2">
            <Smartphone size={14} className="text-muted-foreground" /> Show device toolbar
          </span>
          <SoonTag />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="flex items-center justify-between px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">Zoom</span>
          <span className="flex items-center gap-1">
            <Button variant="ghost" size="icon-xs" className="h-5 w-5">
              <Minus size={12} />
            </Button>
            <span className="w-9 text-center tabular-nums">100%</span>
            <Button variant="ghost" size="icon-xs" className="h-5 w-5">
              <Plus size={12} />
            </Button>
            <Button variant="ghost" size="icon-xs" className="ml-1 h-5 w-5">
              <RotateCw size={11} />
            </Button>
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2 px-3 py-1.5 text-xs">
          <Cookie size={14} className="text-muted-foreground" /> Clear cookies
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2 px-3 py-1.5 text-xs">
          <Trash2 size={14} className="text-muted-foreground" /> Clear cache
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The clean URL header. Center morphs across empty / focused / loaded. */
function BrowserHeader({
  state,
  hovering,
  designMode,
  onFocusBar,
  onToggleDesign,
}: {
  state: ViewState;
  hovering: boolean;
  designMode: boolean;
  onFocusBar: () => void;
  onToggleDesign: () => void;
}) {
  const loadedHover = state === "loaded" && hovering;
  return (
    <div className="flex h-10 items-center gap-1 border-b border-border/60 px-2">
      <IconBtn icon={ArrowLeft} title="Back" disabled={state !== "loaded"} />
      <IconBtn icon={ArrowRight} title="Forward" disabled />
      {(state === "focused" || state === "loaded") && <IconBtn icon={RotateCw} title="Reload" />}

      <div className="flex flex-1 justify-center px-1">
        {state === "empty" && (
          <button
            onClick={onFocusBar}
            className="w-full max-w-md rounded-full px-3 py-1 text-center text-sm text-muted-foreground transition hover:bg-input/60"
          >
            Enter a URL
          </button>
        )}

        {state === "focused" && (
          <div className="flex w-full max-w-md items-center gap-2 rounded-full bg-input px-3 py-1 ring-2 ring-ring/70 transition-all">
            <input
              autoFocus
              placeholder="Enter a URL"
              className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <ArrowUpRight size={14} className="text-muted-foreground" />
          </div>
        )}

        {state === "loaded" && (
          <div
            className={`flex items-center gap-2 rounded-full px-3 py-1 text-sm transition-all ${
              loadedHover ? "bg-input text-foreground ring-1 ring-border" : "text-foreground/80"
            }`}
          >
            <span>{PAGE.title}</span>
            {loadedHover && (
              <button title="Open in external browser" className="text-muted-foreground hover:text-foreground">
                <ArrowUpRight size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {state === "loaded" && !hovering && (
        <>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onToggleDesign}
            title="Design mode"
            className={`h-7 w-7 ${designMode ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
          >
            <PencilRuler size={15} />
          </Button>
          <IconBtn icon={Camera} title="Screenshot" />
        </>
      )}
      <OverflowMenu />
    </div>
  );
}

/** Capture-mode tool in the design toolbar. */
function ToolBtn({ icon: Icon, label, active }: { icon: typeof Globe; label: string; active?: boolean }) {
  return (
    <button
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs transition ${
        active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      <Icon size={13} />
      {label}
    </button>
  );
}

/**
 * Design mode overlay: a capture toolbar over the page, a live region selection,
 * and a tray of captured shots to attach to the chat as design context.
 */
function DesignModeOverlay({ onExit }: { onExit: () => void }) {
  return (
    <div className="absolute inset-0">
      <div className="absolute inset-0 bg-background/50" />
      {/* a sample region selection */}
      <div className="absolute left-10 top-20 h-28 w-56 rounded border-2 border-primary/70 bg-primary/5" />

      {/* capture toolbar */}
      <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-md">
        <ToolBtn icon={SquareDashedMousePointer} label="Region" active />
        <ToolBtn icon={Monitor} label="Viewport" />
        <ToolBtn icon={Scroll} label="Full page" />
        <span className="mx-1 h-5 w-px bg-border" />
        <IconBtn icon={Smartphone} title="Device frame" />
        <IconBtn icon={X} title="Exit design mode" onClick={onExit} />
      </div>

      {/* captures tray */}
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-popover p-2 shadow-md">
        <div className="h-12 w-16 rounded border border-border bg-card" />
        <div className="h-12 w-16 rounded border border-border bg-card" />
        <Button size="xs" className="ml-1 h-8 gap-1.5">
          <Paperclip size={13} /> Attach 2 to chat
        </Button>
      </div>
    </div>
  );
}

/** Empty-state body: detected localhost ports to open. */
function LocalPortsBody() {
  return (
    <div className="mx-auto mt-24 w-full max-w-md px-6">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Local</span>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled
          title="Sort & filter (coming soon)"
          className="h-6 w-6 text-muted-foreground opacity-40"
        >
          <SlidersHorizontal size={13} />
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {LOCAL_PORTS.map((p) => (
          <button
            key={p.port}
            className="flex items-center gap-3 rounded-lg border border-border bg-card/40 px-3 py-2.5 text-left transition hover:bg-card"
          >
            <span className="flex h-9 w-12 items-center justify-center overflow-hidden rounded border border-border bg-background">
              <span className="flex flex-col gap-0.5">
                <span className="flex gap-0.5">
                  <span className="h-1 w-1 rounded-full bg-red-400/70" />
                  <span className="h-1 w-1 rounded-full bg-amber-400/70" />
                  <span className="h-1 w-1 rounded-full bg-emerald-400/70" />
                </span>
                <span className="h-3 w-8 rounded-[1px] bg-muted" />
              </span>
            </span>
            <span className="flex-1">
              <span className="block text-sm font-medium text-foreground">{p.name}</span>
              <span className="block text-xs text-muted-foreground">localhost:{p.port}</span>
            </span>
            <span
              className={`h-2 w-2 rounded-full ${p.online ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
              title={p.online ? "Online" : "Offline"}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Throwaway browser-view prototype. Mounted by App on ?prototype=browser.
 * The state switcher walks the header through empty / focused / loaded.
 */
export function BrowserViewPrototype() {
  const [state, setStateRaw] = useState<ViewState>("empty");
  const [hovering, setHovering] = useState(false);
  const [designMode, setDesignMode] = useState(false);

  // Design mode only exists on a loaded page; leaving the loaded state exits it.
  const setState = (s: ViewState) => {
    setStateRaw(s);
    if (s !== "loaded") setDesignMode(false);
  };

  useEffect(() => {
    const html = document.documentElement;
    const had = html.classList.contains("dark");
    html.classList.add("dark");
    return () => {
      if (!had) html.classList.remove("dark");
    };
  }, []);

  return (
    <div className="flex h-screen flex-col bg-page text-foreground">
      {/* Prototype scaffolding — not part of the design under evaluation. */}
      <div className="flex items-center gap-3 border-b border-border bg-background px-4 py-2 text-xs">
        <span className="font-semibold text-foreground/80">Browser-view prototype</span>
        <span className="text-muted-foreground">state:</span>
        {(["empty", "focused", "loaded"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setState(s)}
            className={`rounded px-2 py-0.5 capitalize ${
              state === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            }`}
          >
            {s}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-1.5 text-muted-foreground">
          <input type="checkbox" checked={hovering} onChange={(e) => setHovering(e.target.checked)} />
          hover URL bar
        </label>
      </div>

      <div className="flex flex-1 justify-end overflow-hidden p-1.5">
        <div className="flex h-full w-[440px] flex-col overflow-hidden rounded-lg bg-background shadow-sm">
          <BrowserHeader
            state={state}
            hovering={hovering}
            designMode={designMode}
            onFocusBar={() => setState("focused")}
            onToggleDesign={() => setDesignMode((d) => !d)}
          />
          <div className="flex-1 overflow-hidden">
            {state === "loaded" ? (
              <div className="relative h-full">
                <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                  <Globe size={26} className="opacity-50" />
                  <span className="text-xs">page content for {PAGE.title}</span>
                </div>
                {designMode && <DesignModeOverlay onExit={() => setDesignMode(false)} />}
              </div>
            ) : (
              <LocalPortsBody />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
