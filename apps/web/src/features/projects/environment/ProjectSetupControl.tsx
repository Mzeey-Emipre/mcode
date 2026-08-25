import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, CircleCheck, OctagonX } from "lucide-react";
import type { WorkspaceEnvironmentSetupAttempt } from "@mcode/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { getTransport } from "@/transport";
import { cn } from "@/lib/utils";
import { isProjectCommandApprovalInvalid, ProjectCommandApprovalDialog } from "./ProjectCommandApprovalDialog";

interface ProjectSetupMenuItemProps {
  readonly attempt: WorkspaceEnvironmentSetupAttempt | null;
  readonly starting: boolean;
  readonly onStart: () => Promise<void>;
}

interface ProjectSetupAttemptCardProps {
  readonly attempt: WorkspaceEnvironmentSetupAttempt;
  readonly onApprove?: () => Promise<void>;
}

/** Loads and starts the transient Setup attempt shown for one Thread Overview. */
export function useProjectSetupAttempt(threadId: string): {
  readonly attempt: WorkspaceEnvironmentSetupAttempt | null;
  readonly starting: boolean;
  readonly startError: string | null;
  readonly start: () => Promise<void>;
  readonly approve: () => Promise<void>;
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
    if (visibleStarting || visibleAttempt?.status === "running" || visibleAttempt?.status === "awaiting-approval" || visibleAttempt?.cleanupPending) return;
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

  const approve = useCallback(async () => {
    const approval = visibleAttempt?.snapshot.approval;
    if (!approval || visibleStarting) return;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    requestSequence.current += 1;
    setStarting(true);
    setStartError(null);
    try {
      await getTransport().approveWorkspaceEnvironmentCommand(threadId, approval.target, approval.fingerprint);
      const next = await getTransport().startWorkspaceSetup(threadId);
      if (isCurrent(threadId, generation)) setAttempt(next);
    } catch (error) {
      if (isProjectCommandApprovalInvalid(error)) {
        const next = await getTransport().startWorkspaceSetup(threadId);
        if (isCurrent(threadId, generation)) setAttempt(next);
      }
      if (isCurrent(threadId, generation)) setStartError("Setup could not be approved");
      throw error;
    } finally {
      if (isCurrent(threadId, generation)) setStarting(false);
    }
  }, [isCurrent, threadId, visibleAttempt?.snapshot.approval, visibleStarting]);

  return {
    attempt: visibleAttempt,
    starting: visibleStarting,
    startError: visibleStartError,
    start,
    approve,
  };
}

/** Renders the manual Setup command within the Project Actions menu. */
export function ProjectSetupMenuItem({ attempt, starting, onStart }: ProjectSetupMenuItemProps) {
  const disabled = attempt?.status === "running" || attempt?.status === "awaiting-approval" || attempt?.cleanupPending === true;
  return (
    <DropdownMenuItem disabled={disabled || starting} onClick={() => { void onStart(); }}>
      {starting ? <Spinner size={13} aria-hidden /> : null}
      Run Setup
    </DropdownMenuItem>
  );
}

/** Renders the compact expandable terminal-style card for a manual Setup attempt. */
export function ProjectSetupAttemptCard({ attempt, onApprove }: ProjectSetupAttemptCardProps) {
  const [open, setOpen] = useState(attempt.status !== "passed");
  const [approvalOpen, setApprovalOpen] = useState(true);
  const contentId = useId();
  const headingId = useId();
  const statusLabel = setupStatusLabel(attempt.status);
  const command = attempt.snapshot.script;

  useEffect(() => {
    if (attempt.status !== "passed") setOpen(true);
  }, [attempt.id, attempt.status]);

  useEffect(() => {
    setApprovalOpen(attempt.status === "awaiting-approval");
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
            aria-label={`Setup ${statusLabel}. ${open ? "Hide" : "Show"} details`}
            aria-controls={contentId}
            className="h-8 w-full justify-between rounded-none px-2.5 text-xs motion-reduce:transition-none"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="font-medium text-foreground">Setup</span>
              <SetupAttemptStatus status={attempt.status} />
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
            {command ? <TerminalBlock label="Command" value={command} wraps /> : null}
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
            {attempt.status === "awaiting-approval" && !approvalOpen ? (
              <Button type="button" size="sm" className="mt-2" onClick={() => setApprovalOpen(true)}>Review shared command</Button>
            ) : null}
          </div>
        </CollapsibleContent>
      </section>
      {approvalOpen ? (
        <ProjectCommandApprovalDialog
          approval={attempt.status === "awaiting-approval" ? attempt.snapshot.approval ?? null : null}
          script={attempt.snapshot.script}
          onApprove={async () => {
            await (onApprove ?? (async () => undefined))();
            return true;
          }}
          onCancel={() => setApprovalOpen(false)}
        />
      ) : null}
    </Collapsible>
  );
}

function TerminalBlock({ label, value, wraps = false }: {
  readonly label: string;
  readonly value: string;
  readonly wraps?: boolean;
}) {
  return (
    <div className="mt-2 first:mt-0">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <ScrollArea
        className={cn("overflow-hidden rounded-md bg-background/60", wraps && "max-h-40")}
        horizontalScrollbar={wraps ? undefined : true}
        viewportClassName={wraps ? undefined : "max-h-40"}
        viewportProps={{ tabIndex: 0, "aria-label": `Setup ${label.toLowerCase()}` }}
      >
        <pre className={cn(
          "font-mono text-xs leading-5 text-foreground",
          wraps ? "p-2 whitespace-pre-wrap break-words" : "min-w-max whitespace-pre p-2",
        )}>{value}</pre>
      </ScrollArea>
    </div>
  );
}

function SetupAttemptStatus({ status }: { readonly status: WorkspaceEnvironmentSetupAttempt["status"] }) {
  switch (status) {
    case "running":
      return (
        <>
          <Spinner size={12} aria-hidden className="motion-reduce:animate-none" />
          <span className="sr-only">Setup running</span>
        </>
      );
    case "awaiting-approval":
      return <Badge variant="secondary" size="sm" className="shrink-0">Approval required</Badge>;
    case "passed":
      return <CircleCheck className="size-3.5 shrink-0 text-[var(--diff-add-strong)]" aria-hidden />;
    case "failed":
      return (
        <span className="flex shrink-0 items-center gap-1.5 rounded-sm bg-[var(--diff-remove)]/15 px-1.5 py-px font-mono text-xs font-medium leading-4 text-[var(--diff-remove)]">
          <OctagonX className="size-3" aria-hidden />
          failed
        </span>
      );
    case "unavailable":
      return <span className="shrink-0 text-xs text-muted-foreground">Unavailable</span>;
  }
}

function setupStatusLabel(status: WorkspaceEnvironmentSetupAttempt["status"]): string {
  switch (status) {
    case "running": return "Running";
    case "awaiting-approval": return "Approval required";
    case "passed": return "Passed";
    case "failed": return "Failed";
    case "unavailable": return "Unavailable";
  }
}
