import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleAlert,
  FolderCheck,
  FolderOpen,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  Plus,
} from "lucide-react";
import { ClaudeIcon, CodexIcon, CursorProviderIcon } from "@/components/chat/ProviderIcons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type PrototypeVariant = "A" | "B" | "C";
type ThreadView = "active" | "completed";
type Provider = "claude" | "codex" | "cursor";

interface PrototypeThread {
  id: string;
  projectId: string;
  title: string;
  provider: Provider;
  updated: string;
  deletion: string;
  pr?: { number: number; state: "open" | "merged" };
  runtime?: "idle" | "running" | "action";
}

interface PrototypeProject {
  id: string;
  name: string;
}

const PROTOTYPE_PARAM = "threadCompletionPrototype";
const VARIANT_ORDER: PrototypeVariant[] = ["A", "B", "C"];
const VARIANT_NAMES: Record<PrototypeVariant, string> = {
  A: "Footer swap",
  B: "Project switch",
  C: "Global view",
};

const PROJECTS: PrototypeProject[] = [
  { id: "mcode", name: "Mcode" },
  { id: "fixture", name: "Fixture repo" },
];

const THREADS: PrototypeThread[] = [
  {
    id: "completion-flow",
    projectId: "mcode",
    title: "Thread completion flow",
    provider: "codex",
    updated: "Updated 4 min ago",
    deletion: "Deletes Aug 13 at 14:30",
    pr: { number: 1214, state: "open" },
  },
  {
    id: "cleanup-safety",
    projectId: "mcode",
    title: "Protect worktree cleanup",
    provider: "claude",
    updated: "Updated 18 min ago",
    deletion: "Deletes Aug 13 at 14:12",
    runtime: "running",
  },
  {
    id: "provider-adapter",
    projectId: "mcode",
    title: "Provider adapter conformance",
    provider: "cursor",
    updated: "Updated 2 hr ago",
    deletion: "Deletes Aug 13 at 12:45",
    pr: { number: 1208, state: "merged" },
  },
  {
    id: "sidebar-density",
    projectId: "mcode",
    title: "Review sidebar density",
    provider: "codex",
    updated: "Updated yesterday",
    deletion: "Deletes tomorrow at 09:00",
  },
  {
    id: "blocked-cleanup",
    projectId: "mcode",
    title: "Resolve dirty worktree",
    provider: "claude",
    updated: "Updated 3 days ago",
    deletion: "Cleanup blocked: uncommitted changes",
    runtime: "action",
  },
  {
    id: "fixture-action",
    projectId: "fixture",
    title: "Verify fixture action",
    provider: "codex",
    updated: "Updated 23 min ago",
    deletion: "Deletes Aug 13 at 14:07",
    pr: { number: 1210, state: "open" },
  },
  {
    id: "browser-state",
    projectId: "fixture",
    title: "Check Browser state",
    provider: "cursor",
    updated: "Updated 5 hr ago",
    deletion: "Deletes Aug 13 at 09:30",
  },
  {
    id: "completed-fixture",
    projectId: "fixture",
    title: "Capture completed fixture",
    provider: "claude",
    updated: "Updated 2 days ago",
    deletion: "Deletes tomorrow at 16:20",
  },
];

const INITIAL_COMPLETED_IDS = new Set([
  "provider-adapter",
  "sidebar-density",
  "blocked-cleanup",
  "completed-fixture",
]);

const PROVIDER_ICONS: Record<Provider, ComponentType<{ size?: number; className?: string }>> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  cursor: CursorProviderIcon,
};

function getPrototypeVariant(): PrototypeVariant | null {
  if (!import.meta.env.DEV) return null;
  const value = new URLSearchParams(window.location.search).get(PROTOTYPE_PARAM)?.toUpperCase();
  return value === "A" || value === "B" || value === "C" ? value : null;
}

/** Returns the active prototype variant when the development-only query parameter is present. */
export function getThreadCompletionPrototypeVariant(): PrototypeVariant | null {
  return getPrototypeVariant();
}

function replacePrototypeVariant(variant: PrototypeVariant): void {
  const url = new URL(window.location.href);
  url.searchParams.set(PROTOTYPE_PARAM, variant);
  window.history.replaceState(window.history.state, "", url);
}

function ProjectHeader({
  project,
  leading,
  trailing,
}: {
  project: PrototypeProject;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="group/project flex h-8 items-center gap-1.5 px-2 text-sm text-foreground">
      {leading ?? <FolderOpen size={14} className="shrink-0 text-muted-foreground/80" aria-hidden />}
      <span className="min-w-0 flex-1 truncate font-medium tracking-tight">{project.name}</span>
      {trailing}
    </div>
  );
}

function RuntimeMarker({ runtime }: { runtime: PrototypeThread["runtime"] }) {
  if (runtime === "running") {
    return <LoaderCircle size={13} className="animate-spin text-primary" aria-label="Running" />;
  }
  if (runtime === "action") {
    return <CircleAlert size={13} className="text-amber-500" aria-label="Cleanup blocked" />;
  }
  return null;
}

function PullRequestMarker({ thread, muted = false }: { thread: PrototypeThread; muted?: boolean }) {
  if (!thread.pr) {
    return (
      <span className={cn(muted && "grayscale opacity-45")}>
        <RuntimeMarker runtime={thread.runtime} />
      </span>
    );
  }
  const Icon = thread.pr.state === "merged" ? GitMerge : GitPullRequest;
  return (
    <span
      className={cn("flex items-center gap-1", muted && "grayscale opacity-45")}
      aria-label={`PR #${thread.pr.number}, ${thread.pr.state}`}
    >
      <Icon
        size={13}
        className={thread.pr.state === "merged" ? "text-primary/70" : "text-muted-foreground/65"}
        aria-hidden
      />
      <RuntimeMarker runtime={thread.runtime} />
    </span>
  );
}

function CompletionControl({
  completed,
  disabled,
  onChange,
}: {
  completed: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  const label = completed ? "Reopen thread" : disabled ? "Thread cannot be completed while running" : "Mark thread complete";
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={disabled}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onChange();
      }}
      className={cn(
        "size-5 rounded-full p-0 text-muted-foreground/65 shadow-none hover:bg-transparent hover:text-foreground",
        completed && "text-muted-foreground/60",
      )}
    >
      {completed ? <Check size={13} strokeWidth={2.5} /> : <Circle size={13} strokeWidth={1.8} />}
    </Button>
  );
}

function PrototypeThreadRow({
  thread,
  completed,
  onToggle,
  emphasis = "standard",
}: {
  thread: PrototypeThread;
  completed: boolean;
  onToggle: () => void;
  emphasis?: "standard" | "compact";
}) {
  const ProviderIcon = PROVIDER_ICONS[thread.provider];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            data-testid={`prototype-thread-${thread.id}`}
            className={cn(
              "group flex h-7 min-w-0 items-center gap-1.5 rounded-md pl-5 pr-2 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground",
              emphasis === "compact" && "pl-3",
            )}
          >
            <span className="pointer-events-none flex size-5 shrink-0 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 motion-reduce:transition-none">
              <CompletionControl
                completed={completed}
                disabled={!completed && thread.runtime === "running"}
                onChange={onToggle}
              />
            </span>
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center",
                completed && "grayscale opacity-45",
              )}
              aria-label={`Provider, ${thread.provider}`}
            >
              <ProviderIcon size={12} className="text-muted-foreground/80" />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                completed && "text-muted-foreground/55 line-through decoration-muted-foreground/55 decoration-1",
              )}
            >
              {thread.title}
            </span>
            <PullRequestMarker thread={thread} muted={completed} />
          </div>
        }
      />
      <TooltipContent side="right" align="start" sideOffset={8} variant="surface" className="w-64 p-3">
        <div className="space-y-2 text-popover-foreground">
          <div className="font-medium">{thread.title}</div>
          <div className="space-y-1 text-muted-foreground">
            <div>{thread.updated}</div>
            <div>{completed ? thread.deletion : "Active thread"}</div>
            {thread.pr ? <div>PR #{thread.pr.number} · {thread.pr.state}</div> : null}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function threadsForProject(projectId: string, completedIds: Set<string>, view: ThreadView): PrototypeThread[] {
  return THREADS.filter((thread) => thread.projectId === projectId && completedIds.has(thread.id) === (view === "completed"));
}

interface VariantProps {
  completedIds: Set<string>;
  toggleThread: (threadId: string) => void;
}

function ProjectViewToggle({
  view,
  activeCount,
  completedCount,
  onToggle,
}: {
  view: ThreadView;
  activeCount: number;
  completedCount: number;
  onToggle: () => void;
}) {
  const viewingCompleted = view === "completed";
  const label = viewingCompleted
    ? `View ${activeCount} active threads`
    : `View ${completedCount} completed threads`;
  const RestingIcon = viewingCompleted ? FolderCheck : FolderOpen;
  const DestinationIcon = viewingCompleted ? FolderOpen : FolderCheck;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            aria-pressed={viewingCompleted}
            onClick={onToggle}
            className="relative -m-2 mr-0 size-8 shrink-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground"
          >
            <RestingIcon
              size={14}
              className="transition-opacity duration-150 group-hover/project:opacity-0 group-focus-within/project:opacity-0 motion-reduce:transition-none"
              aria-hidden
            />
            <DestinationIcon
              size={14}
              className="absolute opacity-0 transition-opacity duration-150 group-hover/project:opacity-100 group-focus-within/project:opacity-100 motion-reduce:transition-none"
              aria-hidden
            />
          </Button>
        }
      />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function VariantA({ completedIds, toggleThread }: VariantProps) {
  const [views, setViews] = useState<Record<string, ThreadView>>({});
  return (
    <PrototypeFrame label="A · Footer swap">
      {PROJECTS.map((project) => {
        const view = views[project.id] ?? "active";
        const active = threadsForProject(project.id, completedIds, "active");
        const completed = threadsForProject(project.id, completedIds, "completed");
        const visible = view === "active" ? active : completed;
        return (
          <section key={project.id} className="pb-1" aria-label={`${project.name}, ${view} threads`}>
            <ProjectHeader project={project} />
            {view === "completed" ? (
              <div className="mb-0.5 flex h-7 items-center gap-1 pl-5 pr-2 text-xs text-muted-foreground">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setViews((current) => ({ ...current, [project.id]: "active" }))}
                  className="h-6 gap-1 px-1.5 font-normal shadow-none"
                >
                  <ArrowLeft size={12} /> Active
                </Button>
                <span className="ml-auto tabular-nums">Completed · {completed.length}</span>
              </div>
            ) : null}
            {visible.map((thread) => (
              <PrototypeThreadRow
                key={thread.id}
                thread={thread}
                completed={completedIds.has(thread.id)}
                onToggle={() => toggleThread(thread.id)}
              />
            ))}
            {view === "active" && completed.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setViews((current) => ({ ...current, [project.id]: "completed" }))}
                className="ml-5 h-7 gap-1.5 px-1.5 font-normal text-muted-foreground shadow-none"
              >
                <Check size={12} /> View {completed.length} completed
              </Button>
            ) : null}
          </section>
        );
      })}
    </PrototypeFrame>
  );
}

function VariantB({ completedIds, toggleThread }: VariantProps) {
  const [views, setViews] = useState<Record<string, ThreadView>>({});
  return (
    <PrototypeFrame label="B · Project switch">
      {PROJECTS.map((project) => {
        const view = views[project.id] ?? "active";
        const active = threadsForProject(project.id, completedIds, "active");
        const completed = threadsForProject(project.id, completedIds, "completed");
        const visible = view === "active" ? active : completed;
        return (
          <section key={project.id} className="pb-1.5" aria-label={`${project.name}, ${view} threads`}>
            <ProjectHeader
              project={project}
              leading={
                <ProjectViewToggle
                  view={view}
                  activeCount={active.length}
                  completedCount={completed.length}
                  onToggle={() =>
                    setViews((current) => ({
                      ...current,
                      [project.id]: view === "active" ? "completed" : "active",
                    }))
                  }
                />
              }
            />
            {visible.length > 0 ? visible.map((thread) => (
              <PrototypeThreadRow
                key={thread.id}
                thread={thread}
                completed={completedIds.has(thread.id)}
                onToggle={() => toggleThread(thread.id)}
              />
            )) : (
              <div className="px-7 py-2 text-xs text-muted-foreground">No {view} threads</div>
            )}
          </section>
        );
      })}
    </PrototypeFrame>
  );
}

function VariantC({ completedIds, toggleThread }: VariantProps) {
  const [view, setView] = useState<ThreadView>("active");
  const activeCount = THREADS.length - completedIds.size;
  return (
    <PrototypeFrame
      label="C · Global view"
      header={
        <div className="flex items-center rounded-md bg-muted/55 p-0.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={view === "active"}
            onClick={() => setView("active")}
            className={cn("h-6 px-2 text-xs font-normal shadow-none", view === "active" && "bg-background text-foreground")}
          >
            Active {activeCount}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={view === "completed"}
            onClick={() => setView("completed")}
            className={cn("h-6 gap-1 px-2 text-xs font-normal shadow-none", view === "completed" && "bg-background text-foreground")}
          >
            <Check size={11} /> {completedIds.size}
          </Button>
        </div>
      }
    >
      {PROJECTS.map((project) => {
        const visible = threadsForProject(project.id, completedIds, view);
        if (visible.length === 0) return null;
        return (
          <section key={project.id} className="pb-1" aria-label={`${project.name}, ${view} threads`}>
            <ProjectHeader project={project} trailing={<span className="text-xs tabular-nums text-muted-foreground/55">{visible.length}</span>} />
            {visible.map((thread) => (
              <PrototypeThreadRow
                key={thread.id}
                thread={thread}
                completed={completedIds.has(thread.id)}
                onToggle={() => toggleThread(thread.id)}
                emphasis="compact"
              />
            ))}
          </section>
        );
      })}
    </PrototypeFrame>
  );
}

function PrototypeFrame({
  label,
  header,
  children,
}: {
  label: string;
  header?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="thread-completion-prototype">
      <div className="mb-1 flex min-h-9 items-center justify-between gap-2 px-3 py-1.5">
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">Projects</div>
          <div className="truncate text-xs text-muted-foreground/60">Prototype · {label}</div>
        </div>
        {header ?? (
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Add project" className="text-muted-foreground">
            <Plus size={15} />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-24">{children}</div>
    </div>
  );
}

function PrototypeSwitcher({ variant, onVariant }: { variant: PrototypeVariant; onVariant: (value: PrototypeVariant) => void }) {
  const cycle = useCallback((direction: -1 | 1) => {
    const current = VARIANT_ORDER.indexOf(variant);
    const next = (current + direction + VARIANT_ORDER.length) % VARIANT_ORDER.length;
    onVariant(VARIANT_ORDER[next]!);
  }, [onVariant, variant]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        cycle(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        cycle(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycle]);

  return (
    <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-lg bg-foreground p-1 text-background shadow-md" aria-label="Prototype variant switcher">
      <Button type="button" variant="ghost" size="icon-xs" onClick={() => cycle(-1)} aria-label="Previous prototype variant" className="text-background hover:bg-background/15 hover:text-background">
        <ChevronLeft size={15} />
      </Button>
      <div className="min-w-36 px-2 text-center text-xs font-medium tabular-nums">{variant} · {VARIANT_NAMES[variant]}</div>
      <Button type="button" variant="ghost" size="icon-xs" onClick={() => cycle(1)} aria-label="Next prototype variant" className="text-background hover:bg-background/15 hover:text-background">
        <ChevronRight size={15} />
      </Button>
    </div>
  );
}

/** Development-only project-tree prototype with three URL-addressable interaction variants. */
export function ThreadCompletionProjectTreePrototype({ initialVariant }: { initialVariant: PrototypeVariant }) {
  const [variant, setVariant] = useState(initialVariant);
  const [completedIds, setCompletedIds] = useState(() => new Set(INITIAL_COMPLETED_IDS));

  const toggleThread = useCallback((threadId: string) => {
    setCompletedIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

  const setVariantAndUrl = useCallback((next: PrototypeVariant) => {
    replacePrototypeVariant(next);
    setVariant(next);
  }, []);

  const content = useMemo(() => {
    const props = { completedIds, toggleThread };
    if (variant === "A") return <VariantA {...props} />;
    if (variant === "B") return <VariantB {...props} />;
    return <VariantC {...props} />;
  }, [completedIds, toggleThread, variant]);

  return (
    <>
      {content}
      <PrototypeSwitcher variant={variant} onVariant={setVariantAndUrl} />
    </>
  );
}
