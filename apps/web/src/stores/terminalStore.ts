import { create } from "zustand";

/** A single PTY-backed terminal instance displayed in the terminal panel. */
export interface TerminalInstance {
  readonly id: string;
  readonly threadId: string;
  readonly label: string;
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

interface TerminalState {
  readonly terminals: Record<string, readonly TerminalInstance[]>;
  readonly terminalPanelByThread: Record<string, TerminalPanelState>;
  readonly splitMode: boolean;

  getTerminalPanel: (threadId: string) => TerminalPanelState;
  toggleTerminalPanel: (threadId: string) => void;
  showTerminalPanel: (threadId: string) => void;
  hideTerminalPanel: (threadId: string) => void;
  setTerminalPanelHeight: (threadId: string, height: number) => void;
  setActiveTerminal: (threadId: string, ptyId: string | null) => void;
  addTerminal: (threadId: string, ptyId: string) => void;
  removeTerminal: (ptyId: string) => void;
  removeAllTerminals: (threadId: string) => void;
  toggleSplit: () => void;
}

function generateLabel(existing: readonly TerminalInstance[]): string {
  const numbers = existing.map((t) => {
    const match = t.label.match(/^Terminal (\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
  });
  const max = numbers.length > 0 ? Math.max(...numbers) : 0;
  return `Terminal ${max + 1}`;
}

/** Zustand store for terminal instances and per-thread panel state. */
export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: {},
  terminalPanelByThread: {},
  splitMode: false,

  getTerminalPanel: (threadId) =>
    get().terminalPanelByThread[threadId] ?? TERMINAL_PANEL_DEFAULTS,

  toggleTerminalPanel: (threadId) =>
    set((state) => {
      const current = state.terminalPanelByThread[threadId] ?? TERMINAL_PANEL_DEFAULTS;
      return {
        terminalPanelByThread: {
          ...state.terminalPanelByThread,
          [threadId]: { ...current, visible: !current.visible },
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
      return {
        terminalPanelByThread: {
          ...state.terminalPanelByThread,
          [threadId]: { ...current, visible: false },
        },
      };
    }),

  setTerminalPanelHeight: (threadId, height) =>
    set((state) => {
      const current = state.terminalPanelByThread[threadId] ?? TERMINAL_PANEL_DEFAULTS;
      return {
        terminalPanelByThread: {
          ...state.terminalPanelByThread,
          [threadId]: { ...current, height },
        },
      };
    }),

  setActiveTerminal: (threadId, ptyId) =>
    set((state) => {
      const current = state.terminalPanelByThread[threadId] ?? TERMINAL_PANEL_DEFAULTS;
      return {
        terminalPanelByThread: {
          ...state.terminalPanelByThread,
          [threadId]: { ...current, activeTerminalId: ptyId },
        },
      };
    }),

  addTerminal: (threadId, ptyId) =>
    set((state) => {
      const existing = state.terminals[threadId] ?? [];
      const label = generateLabel(existing);
      const instance: TerminalInstance = { id: ptyId, threadId, label };
      const currentPanel = state.terminalPanelByThread[threadId] ?? TERMINAL_PANEL_DEFAULTS;
      return {
        terminals: {
          ...state.terminals,
          [threadId]: [...existing, instance],
        },
        terminalPanelByThread: {
          ...state.terminalPanelByThread,
          [threadId]: { ...currentPanel, visible: true, activeTerminalId: ptyId },
        },
      };
    }),

  removeTerminal: (ptyId) =>
    set((state) => {
      // Find the owning thread before filtering so the predicate stays pure.
      const ownerEntry = Object.entries(state.terminals).find(([, instances]) =>
        instances.some((t) => t.id === ptyId),
      );
      if (!ownerEntry) return state;
      const [ownerThreadId] = ownerEntry;

      const updatedTerminals: Record<string, readonly TerminalInstance[]> = {};
      for (const [tid, instances] of Object.entries(state.terminals)) {
        const filtered = instances.filter((t) => t.id !== ptyId);
        // Threads with zero remaining terminals are intentionally pruned from the map.
        if (filtered.length > 0) {
          updatedTerminals[tid] = filtered;
        }
      }

      const currentPanel = state.terminalPanelByThread[ownerThreadId] ?? TERMINAL_PANEL_DEFAULTS;
      const needsNewActive = currentPanel.activeTerminalId === ptyId;
      const remaining = updatedTerminals[ownerThreadId] ?? [];
      const nextActive = needsNewActive ? (remaining[0]?.id ?? null) : currentPanel.activeTerminalId;

      return {
        terminals: updatedTerminals,
        terminalPanelByThread: {
          ...state.terminalPanelByThread,
          [ownerThreadId]: { ...currentPanel, activeTerminalId: nextActive },
        },
      };
    }),

  removeAllTerminals: (threadId) =>
    set((state) => {
      if (!state.terminals[threadId] && !state.terminalPanelByThread[threadId]) return state;
      const remainingTerminals = { ...state.terminals };
      delete remainingTerminals[threadId];
      const remainingPanels = { ...state.terminalPanelByThread };
      delete remainingPanels[threadId];
      return {
        terminals: remainingTerminals,
        terminalPanelByThread: remainingPanels,
      };
    }),

  toggleSplit: () => set((state) => ({ splitMode: !state.splitMode })),
}));
