import { create } from "zustand";
import { getTransport } from "@/transport";
import { createBatchedUpdater } from "./batchMiddleware";

/** A single PTY-backed terminal instance displayed in the terminal panel. */
export interface TerminalInstance {
  readonly id: string;
  readonly threadId: string;
  readonly label: string;
}

/** Server-authoritative PTY identity returned during reconnect. */
export interface ActiveTerminalSession {
  readonly ptyId: string;
  readonly threadId: string;
}

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
  readonly splitMode: boolean;

  getTerminalPanel: (threadId: string) => TerminalPanelState;
  toggleTerminalPanel: (threadId: string) => void;
  showTerminalPanel: (threadId: string) => void;
  hideTerminalPanel: (threadId: string) => void;
  setTerminalPanelHeight: (threadId: string, height: number) => void;
  setActiveTerminal: (threadId: string, ptyId: string | null) => void;
  addTerminal: (threadId: string, ptyId: string, shell?: string) => void;
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

/** Zustand store for terminal instances and per-thread panel state. */
export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: {},
  terminalPanelByThread: {},
  ptyToThread: {},
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

  addTerminal: (threadId, ptyId, shell) =>
    set((state) => {
      const existing = state.terminals[threadId] ?? [];
      if (existing.length >= MAX_TERMINALS_PER_SCOPE) return state;
      const label = shell ?? generateLabel(existing);
      const instance: TerminalInstance = { id: ptyId, threadId, label };
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

  reconcileActiveSessions: (sessions) =>
    set((state) => {
      const existingById = new Map(
        Object.values(state.terminals)
          .flat()
          .map((terminal) => [terminal.id, terminal] as const),
      );
      const terminals: Record<string, readonly TerminalInstance[]> = {};
      const ptyToThread: Record<string, string> = {};

      for (const session of sessions) {
        const existing = existingById.get(session.ptyId);
        const scopeTerminals = terminals[session.threadId] ?? [];
        const terminal: TerminalInstance = existing
          ? { ...existing, threadId: session.threadId }
          : {
              id: session.ptyId,
              threadId: session.threadId,
              label: generateLabel(scopeTerminals),
            };
        terminals[session.threadId] = [...scopeTerminals, terminal];
        ptyToThread[session.ptyId] = session.threadId;
      }

      const terminalPanelByThread = { ...state.terminalPanelByThread };
      const allScopes = new Set([
        ...Object.keys(state.terminals),
        ...Object.keys(terminals),
      ]);
      for (const scopeId of allScopes) {
        const current =
          terminalPanelByThread[scopeId] ?? TERMINAL_PANEL_DEFAULTS;
        const active = terminals[scopeId] ?? [];
        const activeTerminalId = active.some(
          (terminal) => terminal.id === current.activeTerminalId,
        )
          ? current.activeTerminalId
          : (active[0]?.id ?? null);
        terminalPanelByThread[scopeId] = { ...current, activeTerminalId };
      }

      return { terminals, ptyToThread, terminalPanelByThread };
    }),

  removeTerminal: (ptyId) =>
    set((state) => {
      // O(1) owner lookup via the reverse index.
      const ownerThreadId = state.ptyToThread[ptyId];
      if (!ownerThreadId) return state;
      const ownerInstances = state.terminals[ownerThreadId];
      if (!ownerInstances) return state;

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

      const currentPanel = state.terminalPanelByThread[threadId];
      return {
        terminals: remainingTerminals,
        ptyToThread: remainingPtyToThread,
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

      return {
        terminals: remainingTerminals,
        ptyToThread: remainingPtyToThread,
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
