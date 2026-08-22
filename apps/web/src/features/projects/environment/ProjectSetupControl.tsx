import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, MoreHorizontal } from "lucide-react";
import type { WorkspaceEnvironmentSetupAttempt } from "@mcode/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { getTransport } from "@/transport";
import { cn } from "@/lib/utils";

interface ProjectSetupMenuProps {
  readonly attempt: WorkspaceEnvironmentSetupAttempt | null;
  readonly starting: boolean;
  readonly onStart: () => Promise<void>;
}

interface ProjectSetupAttemptCardProps {
  readonly attempt: WorkspaceEnvironmentSetupAttempt;
}

/** Loads and starts the transient Setup attempt shown for one Thread Overview. */
export function useProjectSetupAttempt(threadId: string): {
  readonly attempt: WorkspaceEnvironmentSetupAttempt | null;
  readonly starting: boolean;
  readonly startError: string | null;
  readonly start: () => Promise<void>;
} {
  const [attempt, setAttempt] = useState<WorkspaceEnvironmentSetupAttempt | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const requestSequence = useRef(0);
  const currentThreadId = useRef(threadId);
  const visibleForCurrentThread = currentThreadId.current === threadId;
  const visibleAttempt = visibleForCurrentThread ? attempt : null;
  const visibleStarting = visibleForCurrentThread && starting;
  const visibleStartError = visibleForCurrentThread ? startError : null;
  const isCurrent = useCallback((requestedThreadId: string, generation: number): boolean =>
    currentThreadId.current === requestedThreadId && requestGeneration.current === generation,
  []);
  const refresh = useCallback(async () => {
    const generation = requestGeneration.current;
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    try {
      const next = await getTransport().getWorkspaceSetupAttempt(threadId);
      if (isCurrent(threadId, generation) && requestSequence.current === sequence) setAttempt(next);
    } catch {
      if (isCurrent(threadId, generation) && requestSequence.current === sequence) {
        setStartError("Could not refresh Setup status");
      }
    }
  }, [isCurrent, threadId]);

  useEffect(() => {
    currentThreadId.current = threadId;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setAttempt(null);
    setStarting(false);
    setStartError(null);
    void getTransport().getWorkspaceSetupAttempt(threadId)
      .then((next) => {
        if (isCurrent(threadId, generation) && requestSequence.current === sequence) setAttempt(next);
      })
      .catch(() => {
        if (isCurrent(threadId, generation) && requestSequence.current === sequence) setAttempt(null);
      });
    return () => {
      if (currentThreadId.current === threadId) requestGeneration.current += 1;
    };
  }, [isCurrent, threadId]);

  useEffect(() => {
    if (attempt?.status !== "running" && !attempt?.cleanupPending) return;
    const interval = window.setInterval(() => { void refresh(); }, 1_000);
    return () => window.clearInterval(interval);
  }, [attempt?.cleanupPending, attempt?.status, refresh]);

  const start = useCallback(async () => {
    if (visibleStarting || visibleAttempt?.status === "running" || visibleAttempt?.cleanupPending) return;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    requestSequence.current += 1;
    setStarting(true);
    setStartError(null);
    try {
      const next = await getTransport().startWorkspaceSetup(threadId);
      if (isCurrent(threadId, generation)) setAttempt(next);
    } catch {
      if (isCurrent(threadId, generation)) setStartError("Setup could not start");
    } finally {
      if (isCurrent(threadId, generation)) setStarting(false);
    }
  }, [isCurrent, threadId, visibleAttempt?.cleanupPending, visibleAttempt?.status, visibleStarting]);

  return {
    attempt: visibleAttempt,
    starting: visibleStarting,
    startError: visibleStartError,
    start,
  };
}

/** Renders the Setup-only actions menu beside the Project settings control. */
export function ProjectSetupMenu({ attempt, starting, onStart }: ProjectSetupMenuProps) {
  const disabled = attempt?.status === "running" || attempt?.cleanupPending === true;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Project Setup actions"
            className="text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          >
            <MoreHorizontal size={14} aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-36">
        <DropdownMenuItem disabled={disabled || starting} onClick={() => { void onStart(); }}>
          {starting ? <Spinner size={13} aria-hidden /> : null}
          Run Setup
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Renders the compact expandable terminal-style card for a manual Setup attempt. */
export function ProjectSetupAttemptCard({ attempt }: ProjectSetupAttemptCardProps) {
  const [open, setOpen] = useState(attempt.status !== "passed");
  const contentId = useId();
  const headingId = useId();
  const status = setupStatus(attempt.status);
  const command = attempt.snapshot.script;

  useEffect(() => {
    if (attempt.status !== "passed") setOpen(true);
  }, [attempt.id, attempt.status]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="mx-1.5 mt-1.5 overflow-hidden rounded-lg border border-border/60 bg-muted/20">
        <CollapsibleTrigger asChild>
          <Button
            id={headingId}
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Setup ${status.label}. ${open ? "Hide" : "Show"} details`}
            aria-controls={contentId}
            className="h-8 w-full justify-between rounded-none px-2.5 text-xs motion-reduce:transition-none"
          >
            <span className="flex min-w-0 items-center gap-2">
              {attempt.status === "running" ? <Spinner size={12} aria-hidden className="motion-reduce:animate-none" /> : null}
              <span className="font-medium text-foreground">Setup</span>
              <Badge variant={status.variant} size="sm">{status.label}</Badge>
            </span>
            <ChevronDown
              size={14}
              aria-hidden
              className={cn("shrink-0 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-180")}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent id={contentId} role="region" aria-labelledby={headingId} forceMount>
          <div className={cn("border-t border-border/50 p-2.5", !open && "hidden")}>
            {command ? <TerminalBlock label="Command" value={command} /> : null}
            <TerminalBlock label="Output" value={attempt.output || "No output"} />
            {attempt.exitCode !== null ? (
              <p className="mt-2 font-mono text-xs tabular-nums text-muted-foreground">Exit code: {attempt.exitCode}</p>
            ) : null}
            {attempt.outputTruncated ? (
              <p className="mt-2 text-xs text-muted-foreground">Output was truncated.</p>
            ) : null}
            {attempt.cleanupPending ? (
              <p className="mt-2 text-xs text-muted-foreground">Setup cleanup is still pending.</p>
            ) : null}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function TerminalBlock({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="mt-2 first:mt-0">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <ScrollArea className="max-h-40 rounded-md bg-background/60" viewportProps={{ tabIndex: 0, "aria-label": `Setup ${label.toLowerCase()}` }}>
        <pre className="whitespace-pre-wrap break-all p-2 font-mono text-xs leading-5 text-foreground">{value}</pre>
      </ScrollArea>
    </div>
  );
}

function setupStatus(status: WorkspaceEnvironmentSetupAttempt["status"]): {
  readonly label: string;
  readonly variant: "secondary" | "destructive" | "outline";
} {
  switch (status) {
    case "running": return { label: "Running", variant: "secondary" };
    case "passed": return { label: "Passed", variant: "secondary" };
    case "failed": return { label: "Failed", variant: "destructive" };
    case "unavailable": return { label: "Unavailable", variant: "outline" };
  }
}
