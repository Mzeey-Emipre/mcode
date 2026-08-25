import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleCheck, CircleSlash, CircleStop, CircleX, MoreHorizontal, Pencil, Play, RotateCcw } from "lucide-react";
import type { WorkspaceEnvironmentAction, WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getTransport } from "@/transport";
import { useProjectActionStore } from "./state/project-action-store";

const ACTION_RESULT_DISPLAY_MS = 2_000;

interface ProjectActionMenuProps {
  readonly actions: readonly WorkspaceEnvironmentAction[];
  readonly runsByActionId: ReadonlyMap<string, WorkspaceEnvironmentActionRun>;
  readonly onStart: (actionId: string) => Promise<void>;
  readonly onFocus: (actionId: string) => void;
  readonly onEdit: () => void;
  readonly setupMenuItem?: ReactNode;
  readonly loadError?: string | null;
}

interface ProjectActionTerminalViewProps {
  readonly threadId: string;
  readonly actionId: string;
}

type ProjectActionCommand = "stop" | "restart";

interface ProjectActionActivation {
  readonly actionId: string;
  readonly focus: boolean;
  handled: boolean;
}

interface ProjectActionPointerActivation extends ProjectActionActivation {
  readonly pointerId: number;
  released: boolean;
}

const EMPTY_ACTION_RUNS: Readonly<Record<string, WorkspaceEnvironmentActionRun>> = {};

interface LoadedSetupAvailability {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly configurationEpoch: number;
  readonly hasSetup: boolean;
}

/** Renders Project Actions and the eligible manual Setup command beside Project settings. */
export function ProjectActionMenu({ actions, runsByActionId, onStart, onFocus, onEdit, setupMenuItem, loadError = null }: ProjectActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const pointerActivation = useRef<ProjectActionPointerActivation | null>(null);
  const keyboardActivation = useRef<ProjectActionActivation | null>(null);
  const configuredActionIds = useMemo(() => new Set(actions.map((action) => action.id)), [actions]);
  const rows = useMemo(() => [
    ...actions.map((action) => ({ actionId: action.id, actionName: action.name, configured: true })),
    ...[...runsByActionId.values()]
      .filter((run) => !configuredActionIds.has(run.actionId))
      .map((run) => ({ actionId: run.actionId, actionName: run.actionName, configured: false })),
  ], [actions, configuredActionIds, runsByActionId]);
  const startAction = useCallback((actionId: string) => {
    setStartError(null);
    void onStart(actionId).then(
      () => undefined,
      () => setStartError("Project Action could not start."),
    );
  }, [onStart]);
  const hasActionGroup = rows.length > 0 || Boolean(loadError) || Boolean(startError);
  const hasSetup = setupMenuItem !== null && setupMenuItem !== undefined;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Project Actions"
            className="text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          >
            <MoreHorizontal size={14} aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-52">
        <DropdownMenuItem onClick={onEdit}>
          <Pencil size={14} aria-hidden />
          Edit project actions
        </DropdownMenuItem>
        {hasActionGroup || hasSetup ? <DropdownMenuSeparator /> : null}
        {loadError ? <p role="status" className="px-2 py-1.5 text-xs text-destructive">{loadError}</p> : null}
        {startError ? <p role="status" className="px-2 py-1.5 text-xs text-destructive">{startError}</p> : null}
        {rows.map((row) => {
          const run = runsByActionId.get(row.actionId) ?? null;
          const focusAction = run?.status === "running" || !row.configured;
          return (
            <DropdownMenuItem
              key={row.actionId}
              data-testid={`project-action-${row.actionId}`}
              // A fast Running update can reach this controlled menu before its
              // originating pointer gesture settles. Keep the menu current.
              closeOnClick={false}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                keyboardActivation.current = null;
                pointerActivation.current = {
                  actionId: row.actionId,
                  focus: focusAction,
                  handled: false,
                  pointerId: event.pointerId,
                  released: false,
                };
              }}
              onPointerUp={(event) => {
                if (event.button !== 0) return;
                keyboardActivation.current = null;
                const activation = pointerActivation.current;
                if (
                  !activation ||
                  activation.actionId !== row.actionId ||
                  activation.pointerId !== event.pointerId
                ) {
                  pointerActivation.current = {
                    actionId: row.actionId,
                    focus: focusAction,
                    handled: false,
                    pointerId: event.pointerId,
                    released: true,
                  };
                  return;
                }
                activation.released = true;
              }}
              onPointerCancel={(event) => {
                const activation = pointerActivation.current;
                if (activation?.pointerId === event.pointerId) pointerActivation.current = null;
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                pointerActivation.current = null;
                keyboardActivation.current = { actionId: row.actionId, focus: focusAction, handled: false };
              }}
              onClick={() => {
                const keyboard = keyboardActivation.current;
                if (keyboard?.actionId === row.actionId) {
                  if (keyboard.handled) return;
                  keyboard.handled = true;
                  if (keyboard.focus) {
                    onFocus(row.actionId);
                    return;
                  }
                  startAction(row.actionId);
                  return;
                }
                const pointer = pointerActivation.current;
                if (pointer?.actionId === row.actionId && pointer.released) {
                  if (pointer.handled) return;
                  pointer.handled = true;
                  if (pointer.focus) {
                    onFocus(row.actionId);
                    return;
                  }
                  startAction(row.actionId);
                  return;
                }
                if (focusAction) {
                  onFocus(row.actionId);
                  return;
                }
                startAction(row.actionId);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{row.actionName}</span>
              <ActionStatus status={run?.status ?? null} finishedAt={run?.finishedAt ?? null} />
            </DropdownMenuItem>
          );
        })}
        {hasActionGroup && hasSetup ? <DropdownMenuSeparator /> : null}
        {setupMenuItem}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Renders one retained Project Action transcript inside the dedicated Action terminal panel. */
export function ProjectActionTerminalView({ threadId, actionId }: ProjectActionTerminalViewProps) {
  const run = useProjectActionStore((state) =>
    (state.runsByThread[threadId] ?? EMPTY_ACTION_RUNS)[actionId] ?? null,
  );
  const applyRun = useProjectActionStore.getState().applyRun;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [command, setCommand] = useState<ProjectActionCommand | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);

  const stopAction = useCallback(async () => {
    setCommandError(null);
    setCommand("stop");
    try {
      const stopped = await getTransport().stopWorkspaceAction(threadId, actionId);
      if (stopped) applyRun(stopped);
    } catch {
      setCommandError("Project Action could not stop.");
    } finally {
      setCommand(null);
    }
  }, [actionId, applyRun, threadId]);

  const restartAction = useCallback(async () => {
    setCommandError(null);
    setCommand("restart");
    try {
      applyRun(await getTransport().restartWorkspaceAction(threadId, actionId));
    } catch {
      setCommandError("Project Action could not restart.");
    } finally {
      setCommand(null);
    }
  }, [actionId, applyRun, threadId]);

  useEffect(() => {
    if (run) {
      setLoadError(null);
      return;
    }
    let current = true;
    setLoadError(null);
    void getTransport().getWorkspaceActionRun(threadId, actionId).then(
      (hydrated) => {
        if (!current) return;
        if (hydrated) applyRun(hydrated);
        else setLoadError("This Project Action result is unavailable.");
      },
      () => {
        if (current) setLoadError("This Project Action result is unavailable.");
      },
    );
    return () => {
      current = false;
    };
  }, [actionId, applyRun, run, threadId]);

  if (!run && loadError) {
    return <section data-testid={`action-terminal:${actionId}`} className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground" aria-label="Project Action result unavailable">{loadError}</section>;
  }

  if (!run) {
    return <div data-testid={`action-terminal:${actionId}`} className="flex min-h-0 flex-1 items-center justify-center"><Spinner size={16} /></div>;
  }

  return (
    <section
      data-testid={`action-terminal:${run.actionId}`}
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
      aria-label={`${run.actionName} terminal`}
    >
      <div className="flex h-9 items-center gap-2 border-b border-border/50 px-3 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{run.actionName}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Restart ${run.actionName}`}
                disabled={command !== null}
                onClick={restartAction}
              >
                {command === "restart" ? <Spinner size={14} aria-hidden /> : <RotateCcw size={14} aria-hidden />}
              </Button>
            }
          />
          <TooltipContent>Restart Action</TooltipContent>
        </Tooltip>
        {run.status === "running" ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Stop ${run.actionName}`}
                    disabled={command !== null}
                    onClick={stopAction}
                  >
                    {command === "stop" ? <Spinner size={14} aria-hidden /> : <CircleStop size={14} aria-hidden />}
                  </Button>
                }
              />
              <TooltipContent>Stop Action</TooltipContent>
            </Tooltip>
          </>
        ) : null}
        <ActionStatus status={run.status} finishedAt={run.finishedAt} showIdlePlay={false} />
      </div>
      {commandError ? <p role="status" className="border-b border-border/50 px-3 py-2 text-xs text-destructive">{commandError}</p> : null}
      <ScrollArea className="min-h-0 flex-1" viewportProps={{ tabIndex: 0, "aria-label": `${run.actionName} output` }}>
        <ProjectActionTerminalTranscript transcript={run.transcript} />
      </ScrollArea>
      {run.exitCode !== null ? <p className="border-t border-border/50 px-3 py-2 font-mono text-xs text-muted-foreground">Exit code: {run.exitCode}</p> : null}
    </section>
  );
}

/** Loads configured Actions and reads retained runs from renderer-owned action state. */
export function useProjectActions(workspaceId: string, threadId: string): {
  readonly actions: readonly WorkspaceEnvironmentAction[];
  readonly hasSetup: boolean;
  readonly runsByActionId: ReadonlyMap<string, WorkspaceEnvironmentActionRun>;
  readonly start: (actionId: string) => Promise<WorkspaceEnvironmentActionRun>;
  readonly loadError: string | null;
} {
  const [actions, setActions] = useState<readonly WorkspaceEnvironmentAction[]>([]);
  const [setupAvailability, setSetupAvailability] = useState<LoadedSetupAvailability | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const runsByAction = useProjectActionStore((state) => state.runsByThread[threadId] ?? EMPTY_ACTION_RUNS);
  const configurationEpoch = useProjectActionStore((state) =>
    state.configurationEpochByWorkspace[workspaceId] ?? 0,
  );
  const hasSetup = setupAvailability !== null
    && setupAvailability.workspaceId === workspaceId
    && setupAvailability.threadId === threadId
    && setupAvailability.configurationEpoch === configurationEpoch
    && setupAvailability.hasSetup;
  const hydrateRuns = useProjectActionStore.getState().hydrateRuns;
  const beginHydration = useProjectActionStore.getState().beginHydration;
  const endHydration = useProjectActionStore.getState().endHydration;
  const applyRun = useProjectActionStore.getState().applyRun;
  const generation = useRef(0);
  const runsByActionId = useMemo(
    () => new Map(Object.entries(runsByAction)),
    [runsByAction],
  );

  useEffect(() => {
    const current = generation.current + 1;
    generation.current = current;
    const stateAtRequest = useProjectActionStore.getState();
    const requestEpoch = stateAtRequest.updateEpochByThread[threadId] ?? 0;
    const hydrationGeneration = beginHydration(threadId);
    let active = true;
    setActions([]);
    setSetupAvailability(null);
    setLoadError(null);
    void Promise.all([
      getTransport().readWorkspaceEnvironment(workspaceId),
      getTransport().listWorkspaceActionRuns(threadId),
    ]).then(
      ([environment, runs]) => {
        if (!active || generation.current !== current) return;
        setActions(environment.document.actions);
        setSetupAvailability({
          workspaceId,
          threadId,
          configurationEpoch,
          hasSetup: environment.document.setup !== undefined,
        });
        hydrateRuns(threadId, runs, requestEpoch, hydrationGeneration);
      },
      () => {
        if (active && generation.current === current) setLoadError("Project Actions are unavailable.");
      },
    ).finally(() => endHydration(threadId));
    return () => {
      active = false;
    };
  }, [beginHydration, configurationEpoch, endHydration, hydrateRuns, threadId, workspaceId]);

  const start = useCallback(async (actionId: string) => {
    const run = await getTransport().startWorkspaceAction(threadId, actionId);
    applyRun(run);
    return run;
  }, [applyRun, threadId]);

  return { actions, hasSetup, runsByActionId, start, loadError };
}

function ProjectActionTerminalTranscript({ transcript }: { readonly transcript: string }) {
  const segments = useMemo(() => parseAnsiTranscript(transcript || "No output"), [transcript]);
  return (
    <pre className="min-w-max whitespace-pre p-3 font-mono text-xs leading-5 text-foreground">
      {segments.map((segment, index) => (
        <span key={`${index}:${segment.text}`} className={segment.className}>{segment.text}</span>
      ))}
    </pre>
  );
}

interface AnsiTranscriptSegment {
  readonly text: string;
  readonly className: string | undefined;
}

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_BELL = String.fromCharCode(7);
const ANSI_SEQUENCE = new RegExp(
  `${ANSI_ESCAPE}\\[([0-9;]*)m|${ANSI_ESCAPE}(?:\\][^${ANSI_BELL}]*(?:${ANSI_BELL}|${ANSI_ESCAPE}\\\\)|\\[[0-?]*[ -/]*[@-~]|[@-_])`,
  "g",
);

function parseAnsiTranscript(transcript: string): readonly AnsiTranscriptSegment[] {
  const segments: AnsiTranscriptSegment[] = [];
  let color: string | undefined;
  let cursor = 0;
  for (const match of transcript.matchAll(ANSI_SEQUENCE)) {
    if (match.index! > cursor) segments.push({ text: transcript.slice(cursor, match.index), className: color });
    if (match[1] !== undefined) color = ansiColor(match[1]);
    cursor = match.index! + match[0].length;
  }
  if (cursor < transcript.length) segments.push({ text: transcript.slice(cursor), className: color });
  return segments.length > 0 ? segments : [{ text: "", className: color }];
}

function ansiColor(sequence: string): string | undefined {
  let color: string | undefined;
  for (const code of sequence.split(";").map((value) => Number(value || "0"))) {
    if (code === 0 || code === 39) color = undefined;
    if (code === 30 || code === 90) color = "text-foreground";
    if (code === 31 || code === 91) color = "text-red-500";
    if (code === 32 || code === 92) color = "text-emerald-500";
    if (code === 33 || code === 93) color = "text-amber-500";
    if (code === 34 || code === 94) color = "text-blue-500";
    if (code === 35 || code === 95) color = "text-fuchsia-500";
    if (code === 36 || code === 96) color = "text-cyan-500";
    if (code === 37 || code === 97) color = "text-foreground";
  }
  return color;
}

function ActionStatus({
  status,
  finishedAt,
  showIdlePlay = true,
}: {
  readonly status: WorkspaceEnvironmentActionRun["status"] | null;
  readonly finishedAt: string | null;
  readonly showIdlePlay?: boolean;
}) {
  const [showRecentResult, setShowRecentResult] = useState(() => isRecentResult(status, finishedAt));
  useEffect(() => {
    const remaining = resultDisplayRemaining(status, finishedAt);
    setShowRecentResult(remaining > 0);
    if (remaining === 0) return;
    const timer = window.setTimeout(() => setShowRecentResult(false), remaining);
    return () => window.clearTimeout(timer);
  }, [finishedAt, status]);
  if (status === "running") {
    return <span role="status" aria-label="Running" className="ml-2 flex shrink-0 text-amber-600 dark:text-amber-400"><Spinner size={12} aria-hidden className="motion-reduce:animate-none" /></span>;
  }
  if (status === "completed" && showRecentResult) {
    return <span role="status" aria-label="Completed" className="ml-2 flex shrink-0"><CircleCheck className="size-3.5 text-[var(--diff-add-strong)]" aria-hidden /></span>;
  }
  if (status === "failed" && showRecentResult) {
    return <span role="status" aria-label="Failed" className="ml-2 flex shrink-0"><CircleX className="size-3.5 text-[var(--diff-remove)]" aria-hidden /></span>;
  }
  if (status === "interrupted") {
    return <span role="status" aria-label="Interrupted" className="ml-2 flex shrink-0 text-muted-foreground"><CircleStop className="size-3.5" aria-hidden /></span>;
  }
  if (status === "unavailable") {
    return <span role="status" aria-label="Unavailable" className="ml-2 flex shrink-0 text-muted-foreground"><CircleSlash className="size-3.5" aria-hidden /></span>;
  }
  return showIdlePlay ? <Play className="ml-2 size-3.5 shrink-0 text-muted-foreground" aria-label="Play" /> : null;
}

function isRecentResult(status: WorkspaceEnvironmentActionRun["status"] | null, finishedAt: string | null): boolean {
  return resultDisplayRemaining(status, finishedAt) > 0;
}

function resultDisplayRemaining(status: WorkspaceEnvironmentActionRun["status"] | null, finishedAt: string | null): number {
  if ((status !== "completed" && status !== "failed") || finishedAt === null) return 0;
  return Math.max(0, new Date(finishedAt).getTime() + ACTION_RESULT_DISPLAY_MS - Date.now());
}
