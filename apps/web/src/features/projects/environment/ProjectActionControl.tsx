import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { CircleCheck, CircleSlash, CircleStop, CircleX, MoreHorizontal, Pencil, Play, RotateCcw } from "lucide-react";
import type { WorkspaceEnvironmentAction, WorkspaceEnvironmentActionRun, WorkspaceEnvironmentCommandApproval } from "@mcode/contracts";
import { Badge } from "@/components/ui/badge";
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
import { isProjectCommandApprovalInvalid, ProjectCommandApprovalDialog } from "./ProjectCommandApprovalDialog";

const ACTION_RESULT_DISPLAY_MS = 2_000;

interface ProjectActionMenuProps {
  readonly actions: readonly WorkspaceEnvironmentAction[];
  readonly runsByActionId: ReadonlyMap<string, WorkspaceEnvironmentActionRun>;
  readonly onStart: (actionId: string) => Promise<void | WorkspaceEnvironmentActionRun>;
  readonly onApprove?: (actionId: string, approval: WorkspaceEnvironmentCommandApproval) => Promise<void | WorkspaceEnvironmentActionRun>;
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

interface ProjectActionMenuRow {
  readonly actionId: string;
  readonly actionName: string;
  readonly configured: boolean;
}

const EMPTY_ACTION_RUNS: Readonly<Record<string, WorkspaceEnvironmentActionRun>> = {};

interface LoadedSetupAvailability {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly configurationEpoch: number;
  readonly hasSetup: boolean;
}

/** Renders Project Actions and the eligible manual Setup command beside Project settings. */
export function ProjectActionMenu({ actions, runsByActionId, onStart, onApprove, onFocus, onEdit, setupMenuItem, loadError = null }: ProjectActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [approvalRun, setApprovalRun] = useState<WorkspaceEnvironmentActionRun | null>(null);
  const pointerActivation = useRef<ProjectActionPointerActivation | null>(null);
  const keyboardActivation = useRef<ProjectActionActivation | null>(null);
  const configuredActionIds = useMemo(() => new Set(actions.map((action) => action.id)), [actions]);
  const rows = useMemo<readonly ProjectActionMenuRow[]>(() => [
    ...actions.map((action) => ({ actionId: action.id, actionName: action.name, configured: true })),
    ...[...runsByActionId.values()]
      .filter((run) => !configuredActionIds.has(run.actionId) && run.status !== "awaiting-approval")
      .map((run) => ({ actionId: run.actionId, actionName: run.actionName, configured: false })),
  ], [actions, configuredActionIds, runsByActionId]);
  const startAction = useCallback((actionId: string) => {
    setStartError(null);
    void onStart(actionId).then(
      (run) => {
        if (run?.status === "awaiting-approval") setApprovalRun(run);
      },
      () => setStartError("Project Action could not start."),
    );
  }, [onStart]);
  const hasActionGroup = rows.length > 0 || Boolean(loadError) || Boolean(startError);
  const hasSetup = setupMenuItem !== null && setupMenuItem !== undefined;
  return (
    <>
      <ProjectActionMenuDropdown
        open={open}
        onOpenChange={setOpen}
        onEdit={onEdit}
        rows={rows}
        runsByActionId={runsByActionId}
        onStart={startAction}
        onFocus={onFocus}
        pointerActivation={pointerActivation}
        keyboardActivation={keyboardActivation}
        hasActionGroup={hasActionGroup}
        hasSetup={hasSetup}
        loadError={loadError}
        startError={startError}
        setupMenuItem={setupMenuItem}
      />
      <ProjectActionApprovalDialog
        approvalRun={approvalRun}
        onApprove={onApprove}
        onApprovalResolved={setApprovalRun}
        onError={setStartError}
      />
    </>
  );
}

function ProjectActionMenuDropdown({
  open,
  onOpenChange,
  onEdit,
  rows,
  runsByActionId,
  onStart,
  onFocus,
  pointerActivation,
  keyboardActivation,
  hasActionGroup,
  hasSetup,
  loadError,
  startError,
  setupMenuItem,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onEdit: () => void;
  readonly rows: readonly ProjectActionMenuRow[];
  readonly runsByActionId: ReadonlyMap<string, WorkspaceEnvironmentActionRun>;
  readonly onStart: (actionId: string) => void;
  readonly onFocus: (actionId: string) => void;
  readonly pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>;
  readonly keyboardActivation: MutableRefObject<ProjectActionActivation | null>;
  readonly hasActionGroup: boolean;
  readonly hasSetup: boolean;
  readonly loadError: string | null;
  readonly startError: string | null;
  readonly setupMenuItem: ReactNode;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
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
        {rows.map((row) => (
          <ProjectActionMenuItem
            key={row.actionId}
            row={row}
            run={runsByActionId.get(row.actionId) ?? null}
            onStart={onStart}
            onFocus={onFocus}
            pointerActivation={pointerActivation}
            keyboardActivation={keyboardActivation}
          />
        ))}
        {hasActionGroup && hasSetup ? <DropdownMenuSeparator /> : null}
        {setupMenuItem}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectActionMenuItem({
  row,
  run,
  onStart,
  onFocus,
  pointerActivation,
  keyboardActivation,
}: {
  readonly row: ProjectActionMenuRow;
  readonly run: WorkspaceEnvironmentActionRun | null;
  readonly onStart: (actionId: string) => void;
  readonly onFocus: (actionId: string) => void;
  readonly pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>;
  readonly keyboardActivation: MutableRefObject<ProjectActionActivation | null>;
}) {
  const focusAction = run?.status === "running" || !row.configured;
  return (
    <DropdownMenuItem
      data-testid={`project-action-${row.actionId}`}
      closeOnClick={false}
      onPointerDown={(event) => recordProjectActionPointerDown(event, row, focusAction, pointerActivation, keyboardActivation)}
      onPointerUp={(event) => recordProjectActionPointerUp(event, row, focusAction, pointerActivation, keyboardActivation)}
      onPointerCancel={(event) => cancelProjectActionPointer(event, pointerActivation)}
      onKeyDown={(event) => recordProjectActionKeyboard(event, row, focusAction, pointerActivation, keyboardActivation)}
      onClick={() => activateProjectAction(row, run, focusAction, onStart, onFocus, pointerActivation, keyboardActivation)}
    >
      <span className="min-w-0 flex-1 truncate">{row.actionName}</span>
      <ActionStatus status={run?.status ?? null} finishedAt={run?.finishedAt ?? null} />
    </DropdownMenuItem>
  );
}

function recordProjectActionPointerDown(
  event: ReactPointerEvent,
  row: ProjectActionMenuRow,
  focus: boolean,
  pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>,
  keyboardActivation: MutableRefObject<ProjectActionActivation | null>,
): void {
  if (event.button !== 0) return;
  keyboardActivation.current = null;
  pointerActivation.current = { actionId: row.actionId, focus, handled: false, pointerId: event.pointerId, released: false };
}

function recordProjectActionPointerUp(
  event: ReactPointerEvent,
  row: ProjectActionMenuRow,
  focus: boolean,
  pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>,
  keyboardActivation: MutableRefObject<ProjectActionActivation | null>,
): void {
  if (event.button !== 0) return;
  keyboardActivation.current = null;
  const activation = pointerActivation.current;
  if (isCurrentProjectActionPointer(activation, row.actionId, event.pointerId)) {
    activation.released = true;
    return;
  }
  pointerActivation.current = { actionId: row.actionId, focus, handled: false, pointerId: event.pointerId, released: true };
}

function cancelProjectActionPointer(
  event: ReactPointerEvent,
  pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>,
): void {
  if (pointerActivation.current?.pointerId === event.pointerId) pointerActivation.current = null;
}

function recordProjectActionKeyboard(
  event: ReactKeyboardEvent,
  row: ProjectActionMenuRow,
  focus: boolean,
  pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>,
  keyboardActivation: MutableRefObject<ProjectActionActivation | null>,
): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  pointerActivation.current = null;
  keyboardActivation.current = { actionId: row.actionId, focus, handled: false };
}

function activateProjectAction(
  row: ProjectActionMenuRow,
  run: WorkspaceEnvironmentActionRun | null,
  focusAction: boolean,
  onStart: (actionId: string) => void,
  onFocus: (actionId: string) => void,
  pointerActivation: MutableRefObject<ProjectActionPointerActivation | null>,
  keyboardActivation: MutableRefObject<ProjectActionActivation | null>,
): void {
  if (run?.status === "awaiting-approval") {
    onStart(row.actionId);
    return;
  }
  if (consumeProjectActionActivation(keyboardActivation.current, row.actionId, onStart, onFocus)) return;
  const pointer = pointerActivation.current;
  if (pointer?.released && consumeProjectActionActivation(pointer, row.actionId, onStart, onFocus)) return;
  if (focusAction) onFocus(row.actionId);
  else onStart(row.actionId);
}

function consumeProjectActionActivation(
  activation: ProjectActionActivation | null,
  actionId: string,
  onStart: (actionId: string) => void,
  onFocus: (actionId: string) => void,
): boolean {
  if (!activation || activation.actionId !== actionId || activation.handled) return false;
  activation.handled = true;
  if (activation.focus) onFocus(actionId);
  else onStart(actionId);
  return true;
}

function isCurrentProjectActionPointer(
  activation: ProjectActionPointerActivation | null,
  actionId: string,
  pointerId: number,
): activation is ProjectActionPointerActivation {
  return activation?.actionId === actionId && activation.pointerId === pointerId;
}

function ProjectActionApprovalDialog({
  approvalRun,
  onApprove,
  onApprovalResolved,
  onError,
}: {
  readonly approvalRun: WorkspaceEnvironmentActionRun | null;
  readonly onApprove: ProjectActionMenuProps["onApprove"];
  readonly onApprovalResolved: (run: WorkspaceEnvironmentActionRun | null) => void;
  readonly onError: (error: string) => void;
}) {
  if (!approvalRun) return null;
  return (
    <ProjectCommandApprovalDialog
      approval={approvalRun.snapshot.approval ?? null}
      script={approvalRun.snapshot.script}
      onApprove={async () => {
        try {
          const approval = approvalRun.snapshot.approval;
          if (!approval || !onApprove) return false;
          const run = await onApprove(approvalRun.actionId, approval);
          onApprovalResolved(run?.status === "awaiting-approval" ? run : null);
          return run?.status !== "awaiting-approval";
        } catch (error) {
          onApprovalResolved(null);
          onError("Project Action could not start.");
          throw error;
        }
      }}
      onCancel={() => onApprovalResolved(null)}
    />
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
  readonly approve: (actionId: string, approval: WorkspaceEnvironmentCommandApproval) => Promise<WorkspaceEnvironmentActionRun>;
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
      getTransport().readWorkspaceEnvironment(workspaceId, threadId),
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

  const approve = useCallback(async (actionId: string, approval: WorkspaceEnvironmentCommandApproval) => {
    try {
      await getTransport().approveWorkspaceEnvironmentCommand(threadId, approval.target, approval.fingerprint);
      return await start(actionId);
    } catch (error) {
      if (isProjectCommandApprovalInvalid(error)) return await start(actionId);
      throw error;
    }
  }, [start, threadId]);

  return { actions, hasSetup, runsByActionId, start, approve, loadError };
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
    const nextColor = ANSI_COLORS[code];
    if (nextColor !== undefined) color = nextColor ?? undefined;
  }
  return color;
}

const ANSI_COLORS: Readonly<Record<number, string | null>> = {
  0: null,
  30: "text-foreground",
  31: "text-red-500",
  32: "text-emerald-500",
  33: "text-amber-500",
  34: "text-blue-500",
  35: "text-fuchsia-500",
  36: "text-cyan-500",
  37: "text-foreground",
  39: null,
  90: "text-foreground",
  91: "text-red-500",
  92: "text-emerald-500",
  93: "text-amber-500",
  94: "text-blue-500",
  95: "text-fuchsia-500",
  96: "text-cyan-500",
  97: "text-foreground",
};

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
  return <ActionStatusIcon status={status} showRecentResult={showRecentResult} showIdlePlay={showIdlePlay} />;
}

function ActionStatusIcon({
  status,
  showRecentResult,
  showIdlePlay,
}: {
  readonly status: WorkspaceEnvironmentActionRun["status"] | null;
  readonly showRecentResult: boolean;
  readonly showIdlePlay: boolean;
}) {
  const statusNode = actionStatusNode(status, showRecentResult);
  return statusNode ?? (showIdlePlay ? <Play className="ml-2 size-3.5 shrink-0 text-muted-foreground" aria-label="Play" /> : null);
}

const ACTION_STATUS_NODES: Readonly<Partial<Record<NonNullable<WorkspaceEnvironmentActionRun["status"]>, ReactNode>>> = {
  running: <span role="status" aria-label="Running" className="ml-2 flex shrink-0 text-amber-600 dark:text-amber-400"><Spinner size={12} aria-hidden className="motion-reduce:animate-none" /></span>,
  "awaiting-approval": <Badge role="status" aria-label="Approval required" variant="secondary" size="sm" className="ml-2 shrink-0">Approval</Badge>,
  completed: <span role="status" aria-label="Completed" className="ml-2 flex shrink-0"><CircleCheck className="size-3.5 text-[var(--diff-add-strong)]" aria-hidden /></span>,
  failed: <span role="status" aria-label="Failed" className="ml-2 flex shrink-0"><CircleX className="size-3.5 text-[var(--diff-remove)]" aria-hidden /></span>,
  interrupted: <span role="status" aria-label="Interrupted" className="ml-2 flex shrink-0 text-muted-foreground"><CircleStop className="size-3.5" aria-hidden /></span>,
  unavailable: <span role="status" aria-label="Unavailable" className="ml-2 flex shrink-0 text-muted-foreground"><CircleSlash className="size-3.5" aria-hidden /></span>,
};

function actionStatusNode(
  status: WorkspaceEnvironmentActionRun["status"] | null,
  showRecentResult: boolean,
): ReactNode | null {
  if (isExpiredActionResult(status, showRecentResult)) return null;
  return status ? ACTION_STATUS_NODES[status] ?? null : null;
}

function isExpiredActionResult(
  status: WorkspaceEnvironmentActionRun["status"] | null,
  showRecentResult: boolean,
): boolean {
  return (status === "completed" || status === "failed") && !showRecentResult;
}

function isRecentResult(status: WorkspaceEnvironmentActionRun["status"] | null, finishedAt: string | null): boolean {
  return resultDisplayRemaining(status, finishedAt) > 0;
}

function resultDisplayRemaining(status: WorkspaceEnvironmentActionRun["status"] | null, finishedAt: string | null): number {
  if ((status !== "completed" && status !== "failed") || finishedAt === null) return 0;
  return Math.max(0, new Date(finishedAt).getTime() + ACTION_RESULT_DISPLAY_MS - Date.now());
}
