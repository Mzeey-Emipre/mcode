import type { Terminal } from "@xterm/xterm";

/** Snapshot of a live xterm viewport for E2E and devtools. */
export interface TerminalViewportSnapshot {
  readonly viewportY: number;
  readonly length: number;
  readonly rows: number;
  readonly linesFromBottom: number;
}

type TerminalScrollHarnessWindow = Window & {
  __mcodeTerminalScrollHarness?: {
    getViewport(ptyId: string): TerminalViewportSnapshot | null;
    scrollToLine(ptyId: string, line: number): void;
    scrollLines(ptyId: string, amount: number): void;
    writeLines(ptyId: string, count: number): void;
    getAnchors(): Readonly<Record<string, { viewportY: number; linesFromBottom: number }>>;
    listPtyIds(): string[];
  };
};

const termByPtyId = new Map<string, Terminal>();

/**
 * Registers a live xterm instance for devtools and Playwright E2E assertions.
 */
export function registerTerminalScrollHarness(ptyId: string, term: Terminal): void {
  termByPtyId.set(ptyId, term);
}

/**
 * Unregisters harness state when a terminal unmounts.
 */
export function unregisterTerminalScrollHarness(ptyId: string): void {
  termByPtyId.delete(ptyId);
}

function captureViewport(term: Terminal): TerminalViewportSnapshot {
  const buf = term.buffer.active;
  const viewportY = buf.viewportY;
  const rows = term.rows;
  const length = buf.length;
  return {
    viewportY,
    length,
    rows,
    linesFromBottom: Math.max(0, length - viewportY - rows),
  };
}
if (import.meta.env.DEV && typeof window !== "undefined") {
  const w = window as TerminalScrollHarnessWindow;
  w.__mcodeTerminalScrollHarness = {
    getViewport(ptyId: string) {
      const term = termByPtyId.get(ptyId);
      return term ? captureViewport(term) : null;
    },
    scrollToLine(ptyId: string, line: number) {
      termByPtyId.get(ptyId)?.scrollToLine(line);
    },
    scrollLines(ptyId: string, amount: number) {
      termByPtyId.get(ptyId)?.scrollLines(amount);
    },
    writeLines(ptyId: string, count: number) {
      const term = termByPtyId.get(ptyId);
      if (!term) return;
      for (let i = 1; i <= count; i += 1) {
        term.write(`harness-line-${i}\r\n`);
      }
    },
    getAnchors() {
      const debug = (
        window as TerminalScrollHarnessWindow & {
          __mcodeTerminalScrollDebug?: () => {
            anchors: Record<string, { viewportY: number; linesFromBottom: number }>;
            pinned: Record<string, { viewportY: number; linesFromBottom: number }>;
          };
        }
      ).__mcodeTerminalScrollDebug;
      const snap = debug?.();
      return snap ? { ...snap.anchors, ...snap.pinned } : {};
    },
    listPtyIds() {
      return [...termByPtyId.keys()];
    },
  };
}
