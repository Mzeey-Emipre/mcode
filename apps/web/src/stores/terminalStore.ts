import { create } from "zustand";

export interface TerminalInstance {
  readonly id: string;
  readonly threadId: string;
  readonly label: string;
}

interface TerminalState {
  terminals: Record<string, readonly TerminalInstance[]>;
  activeTerminalId: string | null;
  panelVisible: boolean;
  splitMode: boolean;

  addTerminal: (threadId: string, ptyId: string) => void;
  removeTerminal: (ptyId: string) => void;
  removeAllTerminals: (threadId: string) => void;
  setActiveTerminal: (ptyId: string | null) => void;
  togglePanel: () => void;
  showPanel: () => void;
  hidePanel: () => void;
  toggleSplit: () => void;
  syncToThread: (threadId: string | null) => void;
}

function generateLabel(existing: readonly TerminalInstance[]): string {
  const numbers = existing.map((t) => {
    const match = t.label.match(/^Terminal (\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
  });
  const max = numbers.length > 0 ? Math.max(...numbers) : 0;
  return `Terminal ${max + 1}`;
}

function findAllTerminals(
  terminals: Record<string, readonly TerminalInstance[]>,
): readonly TerminalInstance[] {
  return Object.values(terminals).flat();
}

export const useTerminalStore = create<TerminalState>((set) => ({
  terminals: {},
  activeTerminalId: null,
  panelVisible: false,
  splitMode: false,

  addTerminal: (threadId, ptyId) => {
    set((state) => {
      const existing = state.terminals[threadId] ?? [];
      const label = generateLabel(existing);
      const instance: TerminalInstance = {
        id: ptyId,
        threadId,
        label,
      };
      return {
        terminals: {
          ...state.terminals,
          [threadId]: [...existing, instance],
        },
        activeTerminalId: ptyId,
        panelVisible: true,
      };
    });
  },

  removeTerminal: (ptyId) => {
    set((state) => {
      const updatedTerminals: Record<string, readonly TerminalInstance[]> = {};
      let found = false;

      for (const [threadId, instances] of Object.entries(state.terminals)) {
        const filtered = instances.filter((t) => t.id !== ptyId);
        if (filtered.length !== instances.length) {
          found = true;
        }
        // Don't keep empty arrays in the map
        if (filtered.length > 0) {
          updatedTerminals[threadId] = filtered;
        }
      }

      if (!found) {
        return state;
      }

      const wasActive = state.activeTerminalId === ptyId;
      let nextActive = state.activeTerminalId;

      if (wasActive) {
        const allRemaining = findAllTerminals(updatedTerminals);
        nextActive = allRemaining.length > 0 ? allRemaining[0].id : null;
      }

      return {
        terminals: updatedTerminals,
        activeTerminalId: nextActive,
      };
    });
  },

  removeAllTerminals: (threadId) => {
    set((state) => {
      const removed = state.terminals[threadId] ?? [];
      const removedIds = new Set(removed.map((t) => t.id));
      const wasActive =
        state.activeTerminalId !== null &&
        removedIds.has(state.activeTerminalId);

      // Remove the key entirely instead of leaving an empty array
      const updatedTerminals = { ...state.terminals };
      delete updatedTerminals[threadId];

      // Only hide panel if no terminals remain across all threads
      const anyRemaining = Object.values(updatedTerminals).some(
        (list) => list.length > 0,
      );

      return {
        terminals: updatedTerminals,
        activeTerminalId: wasActive ? null : state.activeTerminalId,
        panelVisible: anyRemaining ? state.panelVisible : false,
      };
    });
  },

  setActiveTerminal: (ptyId) => {
    set({ activeTerminalId: ptyId });
  },

  togglePanel: () => {
    set((state) => ({ panelVisible: !state.panelVisible }));
  },

  showPanel: () => {
    set({ panelVisible: true });
  },

  hidePanel: () => {
    set({ panelVisible: false });
  },

  toggleSplit: () => {
    set((state) => ({ splitMode: !state.splitMode }));
  },

  syncToThread: (threadId) => {
    set((state) => {
      if (!threadId) {
        return { activeTerminalId: null };
      }

      const threadTerminals = state.terminals[threadId] ?? [];
      const currentActive = state.activeTerminalId;

      // If current active terminal already belongs to this thread, keep it
      if (currentActive && threadTerminals.some((t) => t.id === currentActive)) {
        return state;
      }

      // Pick first terminal in the thread, or null
      return {
        activeTerminalId: threadTerminals.length > 0 ? threadTerminals[0].id : null,
      };
    });
  },
}));
