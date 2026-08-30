import { create } from "zustand";
import type { TerminalExitMetadata, TerminalSessionState } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { createBatchedUpdater } from "@/stores/batchMiddleware";

/** A single PTY-backed terminal instance displayed in the terminal panel. */
export interface TerminalInstance {
  readonly id: string;
  readonly threadId: string;
  readonly label: string;
  readonly state?: TerminalSessionState;
  readonly exit?: TerminalExitMetadata;
}

/** Server-authoritative PTY identity returned during reconnect. */
export interface ActiveTerminalSession {
  readonly ptyId: string;
  readonly threadId: string;
  readonly state?: TerminalSessionState;
  readonly exit?: TerminalExitMetadata;
}

/** Search matching flags retained independently for each PTY. */
export interface TerminalSearchOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

/** Search query and match snapshot retained independently for each PTY. */
export interface TerminalSearchState {
  readonly open: boolean;
  readonly query: string;
  readonly options: TerminalSearchOptions;
  readonly resultIndex: number;
  readonly resultCount: number;
}

/** Default terminal search options. */
export const TERMINAL_SEARCH_OPTIONS_DEFAULT: TerminalSearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
} as const;

/** Default terminal search state for a PTY without a saved query. */
export const TERMINAL_SEARCH_STATE_DEFAULT: TerminalSearchState = {
  open: false,
  query: "",
  options: TERMINAL_SEARCH_OPTIONS_DEFAULT,
  resultIndex: -1,
  resultCount: 0,
} as const;

/** Per-thread terminal panel state (visibility, height, active terminal). */
export type TerminalPanelState = {
  readonly visible: boolean;
  readonly height: number;
  readonly activeTerminalId: string | null;
};

/** Default state for threads with no panel record. Panels start closed. */
export const TERMINAL_PANEL_DEFAULTS: TerminalPanelState = {
  visible: false,
  height: 300,
  activeTerminalId: null,
} as const;

/** Maximum concurrent shell sessions in one thread or workspace scope. */
export const MAX_TERMINALS_PER_SCOPE = 4;

interface TerminalState {
  readonly terminals: Record<string, readonly TerminalInstance[]>;
  readonly terminalPanelByThread: Record<string, TerminalPanelState>;
  /** Reverse index: ptyId → threadId for O(1) owner lookup in removeTerminal. */
  readonly ptyToThread: Record<string, string>;
  readonly terminalSearchByPty: Record<string, TerminalSearchState>;
  readonly splitMode: boolean;

  getTerminalPanel: (threadId: string) => TerminalPanelState;
  toggleTerminalPanel: (threadId: string) => void;
  showTerminalPanel: (threadId: string) => void;
  hideTerminalPanel: (threadId: string) => void;
  setTerminalPanelHeight: (threadId: string, height: number) => void;
  setActiveTerminal: (threadId: string, ptyId: string | null) => void;
  openTerminalSearch: (ptyId: string) => void;
  closeTerminalSearch: (ptyId: string) => void;
  setTerminalSearchQuery: (ptyId: string, query: string) => void;
  setTerminalSearchOptions: (
    ptyId: string,
    options: TerminalSearchOptions,
  ) => void;
  setTerminalSearchResult: (
    ptyId: string,
    resultIndex: number,
    resultCount: number,
  ) => void;
  clearTerminalSearchResult: (ptyId: string) => void;
  addTerminal: (threadId: string, ptyId: string, shell?: string) => void;
  /** Retains terminal output metadata after a natural or failed session exit. */
  recordTerminalExit: (ptyId: string, exit: TerminalExitMetadata) => void;
  /** Replaces stale client identities with the server's active PTY set. */
  reconcileActiveSessions: (sessions: readonly ActiveTerminalSession[]) => void;
  removeTerminal: (ptyId: string) => void;
  removeAllTerminals: (threadId: string) => void;
  clearThread: (threadId: string) => void;
  toggleSplit: () => void;
}

/**
 * Pause the selected PTY bound to a thread.
 * Resume belongs to TerminalView after its listener and reattach gate exist.
 */
function setPtyPaused(
  state: Pick<TerminalState, "terminalPanelByThread">,
  threadId: string,
): void {
  const ptyId = state.terminalPanelByThread[threadId]?.activeTerminalId;
  if (!ptyId) return;
  const transport = getTransport();
  transport.terminalPause(ptyId).catch(() => {
    // Best-effort. The next visibility toggle will reconcile state.
  });
}

function generateLabel(existing: readonly TerminalInstance[]): string {
  let max = 0;
  for (const t of existing) {
    const match = t.label.match(/^Terminal (\d+)$/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return `Terminal ${max + 1}`;
}

function reconcileActiveTerminalSessions(
  state: Pick<TerminalState, "terminals" | "ptyToThread" | "terminalPanelByThread" | "terminalSearchByPty">,
  sessions: readonly ActiveTerminalSession[],
) {
  const existingById = new Map(
    Object.values(state.terminals).flat().map((terminal) => [terminal.id, terminal] as const),
  );
  const { terminals, ptyToThread } = reconcileTerminalInstances(sessions, existingById);
  return {
    terminals,
    ptyToThread,
    terminalPanelByThread: reconcileTerminalPanels(state, terminals),
    terminalSearchByPty: reconcileTerminalSearch(state.terminalSearchByPty, sessions),
  };
}

function reconcileTerminalInstances(
  sessions: readonly ActiveTerminalSession[],
  existingById: ReadonlyMap<string, TerminalInstance>,
): {
  readonly terminals: Record<string, readonly TerminalInstance[]>;
  readonly ptyToThread: Record<string, string>;
} {
  const terminals: Record<string, readonly TerminalInstance[]> = {};
  const ptyToThread: Record<string, string> = {};
  for (const session of sessions) {
    const scopeTerminals = terminals[session.threadId] ?? [];
    const terminal = reconcileTerminalInstance(session, existingById.get(session.ptyId), scopeTerminals);
    terminals[session.threadId] = [...scopeTerminals, terminal];
    ptyToThread[session.ptyId] = session.threadId;
  }
  return { terminals, ptyToThread };
}

function reconcileTerminalInstance(
  session: ActiveTerminalSession,
  existing: TerminalInstance | undefined,
  scopeTerminals: readonly TerminalInstance[],
): TerminalInstance {
  const terminal = existing ?? { id: session.ptyId, label: generateLabel(scopeTerminals) };
  return {
    ...terminal,
    threadId: session.threadId,
    state: session.state ?? "running",
    ...(session.exit ? { exit: session.exit } : {}),
  };
}

function reconcileTerminalPanels(
  state: Pick<TerminalState, "terminals" | "terminalPanelByThread">,
  terminals: Record<string, readonly TerminalInstance[]>,
): Record<string, TerminalPanelState> {
  const terminalPanelByThread = { ...state.terminalPanelByThread };
  const scopeIds = new Set([...Object.keys(state.terminals), ...Object.keys(terminals)]);
  for (const scopeId of scopeIds) {
    const current = terminalPanelByThread[scopeId] ?? TERMINAL_PANEL_DEFAULTS;
    terminalPanelByThread[scopeId] = {
      ...current,
      activeTerminalId: resolveReconciledActiveTerminalId(current, terminals[scopeId] ?? []),
    };
  }
  return terminalPanelByThread;
}

function resolveReconciledActiveTerminalId(
  panel: TerminalPanelState,
  terminals: readonly TerminalInstance[],
): string | null {
  return terminals.some((terminal) => terminal.id === panel.activeTerminalId)
    ? panel.activeTerminalId
    : terminals[0]?.id ?? null;
}

function reconcileTerminalSearch(
  terminalSearchByPty: Record<string, TerminalSearchState>,
  sessions: readonly ActiveTerminalSession[],
): Record<string, TerminalSearchState> {
  const next = { ...terminalSearchByPty };
  const activePtyIds = new Set(sessions.map((session) => session.ptyId));
  for (const ptyId of Object.keys(next)) {
    if (!activePtyIds.has(ptyId)) delete next[ptyId];
  }
  return next;
}

/** Zustand store for terminal instances and per-thread panel state. */
export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: {},
  terminalPanelByThread: {},
  ptyToThread: {},
  terminalSearchByPty: {},
  splitMode: true,

  getTerminalPanel: (threadId) =>
    get().terminalPanelByThread[threadId] ?? TERMINAL_PANEL_DEFAULTS,

  toggleTerminalPanel: (threadId) =>
    set((state) => {
      const current = state.terminalPanelByThread[threadId] ?? TERMINAL_PANEL_DEFAULTS;
      const nextVisible = !current.visible;
      if (!nextVisible) setPtyPaused(state, threadId);
      return {
        terminalPanelByThread: {
          ...state.terminalPanelByThread,
          [threadId]: { ...current, visible: nextVisible },
        },
      };
    }),

  showTerminalPanel: (threadId) =>
    set((state) => {
      const current = state.terminalPanelByThread[threadId] ?? TERMINAL_PANEL_DEFAULTS;
      return {
        terminalPanelByThread: {
          ...state.terminalPanelByThread,
          [threadId]: { ...current, visible: true },
        },
      };
    }),

  hideTerminalPanel: (threadId) =>
    set((state) => {
      const current = state.terminalPanelByThread[threadId] ?? TERMINAL_PANEL_DEFAULTS;
      if (current.visible) setPtyPaused(state, threadId);
      return {
        terminalPanelByThread: {
          ...state.terminalPanelByThread,
          [threadId]: { ...current, visible: false },
        },
      };
    }),

  setTerminalPanelHeight: () => {
    // Replaced post-creation with a batched version below.
    throw new Error("setTerminalPanelHeight not yet initialised");
  },

  setActiveTerminal: (threadId, ptyId) =>
    set((state) => {
      const current = state.terminalPanelByThread[threadId] ?? TERMINAL_PANEL_DEFAULTS;
      if (current.visible && current.activeTerminalId !== ptyId) {
        const transport = getTransport();
        if (current.activeTerminalId) {
          transport.terminalPause(current.activeTerminalId).catch(() => {});
        }
      }
      return {
        terminalPanelByThread: {
          ...state.terminalPanelByThread,
          [threadId]: { ...current, activeTerminalId: ptyId },
        },
      };
    }),

  openTerminalSearch: (ptyId) =>
    set((state) => {
      const current = state.terminalSearchByPty[ptyId] ?? TERMINAL_SEARCH_STATE_DEFAULT;
      return {
        terminalSearchByPty: {
          ...state.terminalSearchByPty,
          [ptyId]: { ...current, open: true, options: { ...current.options } },
        },
      };
    }),

  closeTerminalSearch: (ptyId) =>
    set((state) => {
      const current = state.terminalSearchByPty[ptyId];
      if (!current) return state;
      return {
        terminalSearchByPty: {
          ...state.terminalSearchByPty,
          [ptyId]: { ...current, open: false, options: { ...current.options } },
        },
      };
    }),

  setTerminalSearchQuery: (ptyId, query) =>
    set((state) => {
      const current = state.terminalSearchByPty[ptyId] ?? TERMINAL_SEARCH_STATE_DEFAULT;
      return {
        terminalSearchByPty: {
          ...state.terminalSearchByPty,
          [ptyId]: {
            ...current,
            query,
            options: { ...current.options },
            resultIndex: -1,
            resultCount: 0,
          },
        },
      };
    }),

  setTerminalSearchOptions: (ptyId, options) =>
    set((state) => {
      const current = state.terminalSearchByPty[ptyId] ?? TERMINAL_SEARCH_STATE_DEFAULT;
      return {
        terminalSearchByPty: {
          ...state.terminalSearchByPty,
          [ptyId]: {
            ...current,
            options: { ...options },
            resultIndex: -1,
            resultCount: 0,
          },
        },
      };
    }),

  setTerminalSearchResult: (ptyId, resultIndex, resultCount) =>
    set((state) => {
      const current = state.terminalSearchByPty[ptyId] ?? TERMINAL_SEARCH_STATE_DEFAULT;
      return {
        terminalSearchByPty: {
          ...state.terminalSearchByPty,
          [ptyId]: {
            ...current,
            options: { ...current.options },
            resultIndex,
            resultCount,
          },
        },
      };
    }),

  clearTerminalSearchResult: (ptyId) =>
    set((state) => {
      const current = state.terminalSearchByPty[ptyId];
      if (!current) return state;
      return {
        terminalSearchByPty: {
          ...state.terminalSearchByPty,
          [ptyId]: {
            ...current,
            options: { ...current.options },
            resultIndex: -1,
            resultCount: 0,
          },
        },
      };
    }),

  addTerminal: (threadId, ptyId, shell) =>
    set((state) => {
      const existing = state.terminals[threadId] ?? [];
      if (existing.length >= MAX_TERMINALS_PER_SCOPE) return state;
      const label = shell ?? generateLabel(existing);
      const instance: TerminalInstance = { id: ptyId, threadId, label, state: "running" };
      const currentPanel = state.terminalPanelByThread[threadId] ?? TERMINAL_PANEL_DEFAULTS;
      if (currentPanel.visible && currentPanel.activeTerminalId) {
        getTransport().terminalPause(currentPanel.activeTerminalId).catch(() => {});
      }
      return {
        terminals: {
          ...state.terminals,
          [threadId]: [...existing, instance],
        },
        ptyToThread: { ...state.ptyToThread, [ptyId]: threadId },
        terminalPanelByThread: {
          ...state.terminalPanelByThread,
          [threadId]: { ...currentPanel, visible: true, activeTerminalId: ptyId },
        },
      };
    }),

  recordTerminalExit: (ptyId, exit) =>
    set((state) => {
      const ownerThreadId = state.ptyToThread[ptyId];
      if (!ownerThreadId) return state;
      const ownerInstances = state.terminals[ownerThreadId];
      if (!ownerInstances) return state;
      const nextState = exit.reason === "host-crash" ||
          exit.reason === "containment-failure" ||
          exit.reason === "protocol-failure"
        ? "failed"
        : "exited";
      return {
        terminals: {
          ...state.terminals,
          [ownerThreadId]: ownerInstances.map((terminal) =>
            terminal.id === ptyId
              ? { ...terminal, state: nextState, exit }
              : terminal,
          ),
        },
      };
    }),

  reconcileActiveSessions: (sessions) =>
    set((state) => reconcileActiveTerminalSessions(state, sessions)),

  removeTerminal: (ptyId) =>
    set((state) => {
      const terminalSearchByPty = { ...state.terminalSearchByPty };
      delete terminalSearchByPty[ptyId];
      // O(1) owner lookup via the reverse index.
      const ownerThreadId = state.ptyToThread[ptyId];
      if (!ownerThreadId) {
        return state.terminalSearchByPty[ptyId]
          ? { terminalSearchByPty }
          : state;
      }
      const ownerInstances = state.terminals[ownerThreadId];
      if (!ownerInstances) return { terminalSearchByPty };

      const filtered = ownerInstances.filter((t) => t.id !== ptyId);
      const updatedTerminals =
        filtered.length > 0
          ? { ...state.terminals, [ownerThreadId]: filtered }
          : (() => {
              const rest = { ...state.terminals };
              delete rest[ownerThreadId];
              return rest;
            })();

      const remainingPtyToThread = { ...state.ptyToThread };
      delete remainingPtyToThread[ptyId];

      const currentPanel = state.terminalPanelByThread[ownerThreadId] ?? TERMINAL_PANEL_DEFAULTS;
      const needsNewActive = currentPanel.activeTerminalId === ptyId;
      const nextActive = needsNewActive ? (filtered[0]?.id ?? null) : currentPanel.activeTerminalId;

      return {
        terminals: updatedTerminals,
        ptyToThread: remainingPtyToThread,
        terminalSearchByPty,
        terminalPanelByThread: {
          ...state.terminalPanelByThread,
          [ownerThreadId]: { ...currentPanel, activeTerminalId: nextActive },
        },
      };
    }),

  removeAllTerminals: (threadId) =>
    set((state) => {
      const threadTerminals = state.terminals[threadId];
      if (!threadTerminals) return state;
      const remainingTerminals = { ...state.terminals };
      delete remainingTerminals[threadId];

      // Clean up reverse index for all removed PTYs.
      const remainingPtyToThread = { ...state.ptyToThread };
      for (const t of threadTerminals) delete remainingPtyToThread[t.id];

      const terminalSearchByPty = { ...state.terminalSearchByPty };
      for (const t of threadTerminals) delete terminalSearchByPty[t.id];

      const currentPanel = state.terminalPanelByThread[threadId];
      return {
        terminals: remainingTerminals,
        ptyToThread: remainingPtyToThread,
        terminalSearchByPty,
        ...(currentPanel
          ? {
              terminalPanelByThread: {
                ...state.terminalPanelByThread,
                [threadId]: { ...currentPanel, activeTerminalId: null },
              },
            }
          : {}),
      };
    }),

  clearThread: (threadId) =>
    set((state) => {
      if (!state.terminals[threadId] && !state.terminalPanelByThread[threadId]) return state;
      const threadTerminals = state.terminals[threadId];
      const remainingTerminals = { ...state.terminals };
      delete remainingTerminals[threadId];
      const remainingPanels = { ...state.terminalPanelByThread };
      delete remainingPanels[threadId];

      // Clean up reverse index for all removed PTYs.
      const remainingPtyToThread = { ...state.ptyToThread };
      if (threadTerminals) {
        for (const t of threadTerminals) delete remainingPtyToThread[t.id];
      }

      const terminalSearchByPty = { ...state.terminalSearchByPty };
      if (threadTerminals) {
        for (const t of threadTerminals) delete terminalSearchByPty[t.id];
      }

      return {
        terminals: remainingTerminals,
        ptyToThread: remainingPtyToThread,
        terminalSearchByPty,
        terminalPanelByThread: remainingPanels,
      };
    }),

  toggleSplit: () => set((state) => ({ splitMode: !state.splitMode })),
}));

// Wire setTerminalPanelHeight through a rAF-batched updater so rapid
// mousemove events during drag-to-resize produce at most one React
// re-render per animation frame instead of one per pixel.
const batchedSet = createBatchedUpdater<TerminalState>(
  useTerminalStore.setState.bind(useTerminalStore),
);

useTerminalStore.setState({
  setTerminalPanelHeight: (threadId: string, height: number) => {
    batchedSet((state) => {
      const current = state.terminalPanelByThread[threadId] ?? TERMINAL_PANEL_DEFAULTS;
      return {
        terminalPanelByThread: {
          ...state.terminalPanelByThread,
          [threadId]: { ...current, height },
        },
      };
    });
  },
});
