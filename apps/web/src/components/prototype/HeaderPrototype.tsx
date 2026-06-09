/**
 * THROWAWAY PROTOTYPE — chat-header revamp (chosen design). NOT production code.
 *
 * Verdict (variant A): keep the project badge + Create PR + Open visible; collapse
 * the old right-panel toggle icons into one consolidated menu (mcode items only,
 * no "environment"/"sources"); add a dedicated right-panel toggle. The Open button
 * is the open-in split button (default-app icon + caret to pick the app) from the
 * open-in work (#601-#603 / ADR-0005).
 *
 * Run:  bun run dev:web  →  http://localhost:5173/?prototype=header
 * Fold into the real chat header, then delete this file.
 */
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  GitPullRequest,
  Menu as MenuIcon,
  PanelRight,
  Diff,
  GitBranch,
  Upload,
  ChevronDown,
  Check,
  Code2,
  Zap,
  Github,
  SquareTerminal,
  FolderOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const TITLE = "/grill-with-docs Hey we need to revamp the right…";

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

function CreatePRButton() {
  return (
    <Button variant="ghost" size="xs" className="h-7 gap-1.5 text-muted-foreground hover:text-foreground">
      <GitPullRequest size={14} />
      <span className="text-xs">Create PR</span>
    </Button>
  );
}

/** Open split button: opens in the default app; caret picks the app (per ADR-0005). */
function OpenSplitButton() {
  const [defaultId, setDefaultId] = useState("code");
  const current = OPEN_IN_APPS.find((a) => a.id === defaultId) ?? OPEN_IN_APPS[0];
  const Icon = current.icon;
  return (
    <div className="flex items-center">
      <Button
        variant="ghost"
        size="xs"
        title={`Open in ${current.label}`}
        className="h-7 gap-1.5 rounded-r-none text-muted-foreground hover:text-foreground"
      >
        <Icon size={14} />
        <span className="text-xs">Open</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              title="Choose app"
              className="h-7 w-6 rounded-l-none border-l border-border text-muted-foreground hover:text-foreground"
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
              className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
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

/** The consolidated menu — the mcode items, no "environment" framing. */
function ConsolidatedMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-xs" title="Workspace" className="h-7 w-7 text-muted-foreground hover:text-foreground">
            <MenuIcon size={15} />
          </Button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-[200px]">
        <DropdownMenuItem className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
          <span className="flex items-center gap-2">
            <Diff size={14} className="text-muted-foreground" /> Changes
          </span>
          <span className="font-mono text-[11px]">
            <span className="text-emerald-500">+233</span> <span className="text-muted-foreground">-0</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
          <span className="flex items-center gap-2">
            <GitBranch size={14} className="text-muted-foreground" /> Branch
          </span>
          <span className="text-[11px] text-muted-foreground">main</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2 px-3 py-1.5 text-xs">
          <Upload size={14} className="text-muted-foreground" /> Commit or push
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={onToggle}
      title="Toggle right panel"
      className={`h-7 w-7 ${open ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
    >
      <PanelRight size={15} />
    </Button>
  );
}

/**
 * Throwaway chat-header prototype (chosen variant A). Mounted by App on
 * ?prototype=header. Fold into the real header, then delete.
 */
export function HeaderPrototype() {
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    const html = document.documentElement;
    const had = html.classList.contains("dark");
    html.classList.add("dark");
    return () => {
      if (!had) html.classList.remove("dark");
    };
  }, []);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex h-12 items-center gap-3 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground/90">{TITLE}</span>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">mcode</span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <CreatePRButton />
          <OpenSplitButton />
          <span className="mx-1 h-5 w-px bg-border" />
          <ConsolidatedMenu />
          <PanelToggle open={panelOpen} onToggle={() => setPanelOpen((o) => !o)} />
        </div>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">thread content</div>
        {panelOpen && (
          <div className="w-64 border-l border-border bg-page p-3 text-xs text-muted-foreground">right panel</div>
        )}
      </div>
    </div>
  );
}
