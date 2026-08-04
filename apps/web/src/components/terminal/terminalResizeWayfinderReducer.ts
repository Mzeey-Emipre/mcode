/** Terminal ids kept by the disposable resize and restoration harness. */
export const TERMINAL_WAYFINDER_IDS = ["A", "B"] as const;

/** A terminal id in the resize and restoration harness. */
export type TerminalWayfinderId = (typeof TERMINAL_WAYFINDER_IDS)[number];

/** Renderer policy being compared by the harness. */
export type TerminalWayfinderPolicy = "native" | "stable";

/** Connection lifecycle shown in the harness telemetry. */
export type TerminalWayfinderConnection =
  | "connected"
  | "disconnected"
  | "reconnecting";

/** Replay lifecycle shown in the harness telemetry. */
export type TerminalWayfinderReplay =
  | "idle"
  | "detached"
  | "replaying"
  | "complete"
  | "gap";

/** One resize request or application recorded for comparison. */
export interface TerminalWayfinderResizeEvent {
  readonly terminalId: TerminalWayfinderId;
  readonly kind: "requested" | "applied" | "rejected";
  readonly reason: "control" | "raf" | "show" | "switch" | "unsafe" | "hidden";
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly cols: number;
  readonly rows: number;
  readonly completeColumns: number;
  readonly completeRows: number;
  readonly at: number;
}

/** Complete renderer-independent telemetry for one fake terminal session. */
export interface TerminalWayfinderTerminal {
  readonly id: TerminalWayfinderId;
  readonly label: string;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly cols: number;
  readonly rows: number;
  readonly completeColumns: number;
  readonly completeRows: number;
  readonly viewportY: number;
  readonly bufferLength: number;
  readonly linesFromBottom: number;
  readonly followingTail: boolean;
  readonly hidden: boolean;
  readonly connection: TerminalWayfinderConnection;
  readonly replay: TerminalWayfinderReplay;
  readonly outputBytes: number;
  readonly detachedOutputBytes: number;
  readonly replayedOutputBytes: number;
  readonly restoredAnchor: boolean;
}

/** State shared by the xterm-backed prototype shell and its reducer. */
export interface TerminalWayfinderState {
  readonly policy: TerminalWayfinderPolicy;
  readonly activeTerminalId: TerminalWayfinderId;
  readonly hidden: boolean;
  readonly scenario: string;
  readonly terminals: Readonly<Record<TerminalWayfinderId, TerminalWayfinderTerminal>>;
  readonly lastResizeEvents: readonly TerminalWayfinderResizeEvent[];
}

/** Actions accepted by the pure resize and restoration reducer. */
export type TerminalWayfinderAction =
  | { readonly type: "set-policy"; readonly policy: TerminalWayfinderPolicy }
  | { readonly type: "set-scenario"; readonly scenario: string }
  | {
      readonly type: "resize-requested";
      readonly terminalId: TerminalWayfinderId;
      readonly pixelWidth: number;
      readonly pixelHeight: number;
      readonly cols: number;
      readonly rows: number;
      readonly completeColumns: number;
      readonly completeRows: number;
      readonly reason: TerminalWayfinderResizeEvent["reason"];
      readonly at: number;
    }
  | {
      readonly type: "resize-applied";
      readonly terminalId: TerminalWayfinderId;
      readonly pixelWidth: number;
      readonly pixelHeight: number;
      readonly cols: number;
      readonly rows: number;
      readonly completeColumns: number;
      readonly completeRows: number;
      readonly viewportY: number;
      readonly bufferLength: number;
      readonly linesFromBottom: number;
      readonly followingTail: boolean;
      readonly restoredAnchor: boolean;
      readonly reason: TerminalWayfinderResizeEvent["reason"];
      readonly at: number;
    }
  | {
      readonly type: "resize-rejected";
      readonly terminalId: TerminalWayfinderId;
      readonly pixelWidth: number;
      readonly pixelHeight: number;
      readonly cols: number;
      readonly rows: number;
      readonly completeColumns: number;
      readonly completeRows: number;
      readonly reason: "unsafe" | "hidden";
      readonly at: number;
    }
  | {
      readonly type: "output";
      readonly terminalId: TerminalWayfinderId;
      readonly bytes: number;
      readonly lines: number;
      readonly detached: boolean;
      readonly viewportY: number;
      readonly bufferLength: number;
      readonly linesFromBottom: number;
      readonly followingTail: boolean;
    }
  | {
      readonly type: "scroll";
      readonly terminalId: TerminalWayfinderId;
      readonly viewportY: number;
      readonly bufferLength: number;
      readonly rows: number;
    }
  | { readonly type: "set-hidden"; readonly hidden: boolean }
  | { readonly type: "switch-terminal"; readonly terminalId: TerminalWayfinderId }
  | { readonly type: "disconnect"; readonly terminalId: TerminalWayfinderId }
  | { readonly type: "reconnect-start"; readonly terminalId: TerminalWayfinderId }
  | {
      readonly type: "replay-applied";
      readonly terminalId: TerminalWayfinderId;
      readonly bytes: number;
      readonly viewportY: number;
      readonly bufferLength: number;
      readonly linesFromBottom: number;
      readonly followingTail: boolean;
      readonly gap: boolean;
    }
  | { readonly type: "reconnect-complete"; readonly terminalId: TerminalWayfinderId; readonly gap: boolean }
  | { readonly type: "reset" };

const CELL_WIDTH_PX = 8;
const CELL_HEIGHT_PX = 18;
const MAX_EVENTS = 12;
const MAX_OUTPUT_BYTES = 128 * 1024;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function appendEvent(
  state: TerminalWayfinderState,
  event: TerminalWayfinderResizeEvent,
): readonly TerminalWayfinderResizeEvent[] {
  return [...state.lastResizeEvents, event].slice(-MAX_EVENTS);
}

function withTerm(
  state: TerminalWayfinderState,
  terminalId: TerminalWayfinderId,
  update: (terminal: TerminalWayfinderTerminal) => TerminalWayfinderTerminal,
): TerminalWayfinderState {
  return {
    ...state,
    terminals: {
      ...state.terminals,
      [terminalId]: update(state.terminals[terminalId]),
    },
  };
}

function visibilityFor(
  state: TerminalWayfinderState,
  activeTerminalId = state.activeTerminalId,
  hidden = state.hidden,
): Readonly<Record<TerminalWayfinderId, TerminalWayfinderTerminal>> {
  return Object.fromEntries(
    TERMINAL_WAYFINDER_IDS.map((id) => [
      id,
      { ...state.terminals[id], hidden: hidden || id !== activeTerminalId },
    ]),
  ) as Readonly<Record<TerminalWayfinderId, TerminalWayfinderTerminal>>;
}

function baseTerminal(
  id: TerminalWayfinderId,
  pixelWidth: number,
  pixelHeight: number,
  hidden: boolean,
): TerminalWayfinderTerminal {
  const completeColumns = Math.floor(pixelWidth / CELL_WIDTH_PX);
  const completeRows = Math.floor(pixelHeight / CELL_HEIGHT_PX);
  return {
    id,
    label: `Terminal ${id}`,
    pixelWidth,
    pixelHeight,
    cols: completeColumns,
    rows: completeRows,
    completeColumns,
    completeRows,
    viewportY: 0,
    bufferLength: 0,
    linesFromBottom: 0,
    followingTail: true,
    hidden,
    connection: "connected",
    replay: "idle",
    outputBytes: 0,
    detachedOutputBytes: 0,
    replayedOutputBytes: 0,
    restoredAnchor: false,
  };
}

/** Creates the deterministic initial state for the terminal wayfinder. */
export function createTerminalWayfinderState(): TerminalWayfinderState {
  const terminals = {
    A: baseTerminal("A", 720, 360, false),
    B: baseTerminal("B", 560, 300, true),
  } as const;
  return {
    policy: "stable",
    activeTerminalId: "A",
    hidden: false,
    scenario: "wrong-width-restoration",
    terminals,
    lastResizeEvents: [],
  };
}

/** Applies one harness action without performing renderer or transport I/O. */
export function reduceTerminalWayfinder(
  state: TerminalWayfinderState,
  action: TerminalWayfinderAction,
): TerminalWayfinderState {
  switch (action.type) {
    case "set-policy":
      return { ...state, policy: action.policy };
    case "set-scenario":
      return { ...state, scenario: action.scenario };
    case "resize-requested":
      return withTerm(
        {
          ...state,
          lastResizeEvents: appendEvent(state, {
            terminalId: action.terminalId,
            kind: "requested",
            reason: action.reason,
            pixelWidth: action.pixelWidth,
            pixelHeight: action.pixelHeight,
            cols: action.cols,
            rows: action.rows,
            completeColumns: action.completeColumns,
            completeRows: action.completeRows,
            at: action.at,
          }),
        },
        action.terminalId,
        (terminal) => ({
          ...terminal,
          pixelWidth: action.pixelWidth,
          pixelHeight: action.pixelHeight,
          completeColumns: action.completeColumns,
          completeRows: action.completeRows,
        }),
      );
    case "resize-applied":
      return withTerm(
        {
          ...state,
          lastResizeEvents: appendEvent(state, {
            terminalId: action.terminalId,
            kind: "applied",
            reason: action.reason,
            pixelWidth: action.pixelWidth,
            pixelHeight: action.pixelHeight,
            cols: action.cols,
            rows: action.rows,
            completeColumns: action.completeColumns,
            completeRows: action.completeRows,
            at: action.at,
          }),
        },
        action.terminalId,
        (terminal) => ({
          ...terminal,
          pixelWidth: action.pixelWidth,
          pixelHeight: action.pixelHeight,
          cols: action.cols,
          rows: action.rows,
          completeColumns: action.completeColumns,
          completeRows: action.completeRows,
          viewportY: action.viewportY,
          bufferLength: action.bufferLength,
          linesFromBottom: action.linesFromBottom,
          followingTail: action.followingTail,
          restoredAnchor: action.restoredAnchor,
        }),
      );
    case "resize-rejected":
      return {
        ...state,
        lastResizeEvents: appendEvent(state, {
          terminalId: action.terminalId,
          kind: "rejected",
          reason: action.reason,
          pixelWidth: action.pixelWidth,
          pixelHeight: action.pixelHeight,
          cols: action.cols,
          rows: action.rows,
          completeColumns: action.completeColumns,
          completeRows: action.completeRows,
          at: action.at,
        }),
      };
    case "output":
      return withTerm(state, action.terminalId, (terminal) => {
        const outputBytes = clamp(terminal.outputBytes + action.bytes, 0, MAX_OUTPUT_BYTES);
        const detachedOutputBytes = action.detached
          ? clamp(terminal.detachedOutputBytes + action.bytes, 0, MAX_OUTPUT_BYTES)
          : terminal.detachedOutputBytes;
        return {
          ...terminal,
          outputBytes,
          detachedOutputBytes,
          bufferLength: action.detached
            ? terminal.bufferLength
            : Math.max(0, action.bufferLength),
          viewportY: action.detached ? terminal.viewportY : Math.max(0, action.viewportY),
          linesFromBottom: action.detached
            ? terminal.linesFromBottom
            : Math.max(0, action.linesFromBottom),
          followingTail: action.detached ? terminal.followingTail : action.followingTail,
          replay: action.detached ? "detached" : terminal.replay === "complete" ? "idle" : terminal.replay,
        };
      });
    case "scroll":
      return withTerm(state, action.terminalId, (terminal) => {
        const maxViewportY = Math.max(0, action.bufferLength - action.rows);
        const viewportY = clamp(action.viewportY, 0, maxViewportY);
        const linesFromBottom = Math.max(0, action.bufferLength - viewportY - action.rows);
        return {
          ...terminal,
          viewportY,
          bufferLength: Math.max(0, action.bufferLength),
          linesFromBottom,
          followingTail: linesFromBottom === 0,
          restoredAnchor: false,
        };
      });
    case "set-hidden":
      return {
        ...state,
        hidden: action.hidden,
        terminals: visibilityFor(state, state.activeTerminalId, action.hidden),
      };
    case "switch-terminal":
      return {
        ...state,
        activeTerminalId: action.terminalId,
        terminals: visibilityFor(state, action.terminalId, state.hidden),
      };
    case "disconnect":
      return withTerm(state, action.terminalId, (terminal) => ({
        ...terminal,
        connection: "disconnected",
        replay: "detached",
      }));
    case "reconnect-start":
      return withTerm(state, action.terminalId, (terminal) => ({
        ...terminal,
        connection: "reconnecting",
        replay: "replaying",
      }));
    case "replay-applied":
      return withTerm(state, action.terminalId, (terminal) => ({
        ...terminal,
        bufferLength: Math.max(0, action.bufferLength),
        viewportY: Math.max(0, action.viewportY),
        linesFromBottom: Math.max(0, action.linesFromBottom),
        followingTail: action.followingTail,
        replayedOutputBytes: clamp(terminal.replayedOutputBytes + action.bytes, 0, MAX_OUTPUT_BYTES),
        replay: action.gap ? "gap" : "replaying",
        restoredAnchor: !action.followingTail,
      }));
    case "reconnect-complete":
      return withTerm(state, action.terminalId, (terminal) => ({
        ...terminal,
        connection: "connected",
        replay: action.gap ? "gap" : "complete",
      }));
    case "reset":
      return createTerminalWayfinderState();
  }
}

/** Returns complete cell estimates for a pixel viewport without touching xterm. */
export function estimateCompleteTerminalGrid(pixelWidth: number, pixelHeight: number): {
  readonly cols: number;
  readonly rows: number;
  readonly completeColumns: number;
  readonly completeRows: number;
} {
  const completeColumns = Math.max(0, Math.floor(pixelWidth / CELL_WIDTH_PX));
  const completeRows = Math.max(0, Math.floor(pixelHeight / CELL_HEIGHT_PX));
  return { cols: completeColumns, rows: completeRows, completeColumns, completeRows };
}
