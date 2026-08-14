import type { Terminal } from "@xterm/xterm";
import type { TerminalReleaseTestRuntime } from "@/transport/types";

/** One active xterm line captured by the protected packaged release probe. */
export interface TerminalReleaseTestLine {
  readonly text: string;
  readonly wrapped: boolean;
}

/** Active-buffer state exposed only to the packaged release-test harness. */
export interface TerminalReleaseTestSnapshot {
  readonly cols: number;
  readonly rows: number;
  readonly cursor: { readonly x: number; readonly y: number };
  readonly lines: readonly TerminalReleaseTestLine[];
  readonly normalizedLines: readonly string[];
}

/** Bounded capability and session observations retained by the packaged probe. */
export interface TerminalReleaseTestRuntimeSnapshot {
  readonly capabilities: {
    readonly contractVersion: number;
    readonly backend: "legacy" | "modern";
    readonly host?: { readonly state: string; readonly generation: string };
    readonly releaseTest?: { readonly hostPid: number };
  };
  readonly capabilityHistory: readonly TerminalReleaseTestRuntimeSnapshot["capabilities"][];
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly state: string;
    readonly hostGeneration: string;
    readonly exitReason: string | null;
  }[];
  readonly sessionHistory: readonly TerminalReleaseTestRuntimeSnapshot["sessions"][];
}

const runtimeHistory: {
  capabilities: TerminalReleaseTestRuntimeSnapshot["capabilities"][];
  sessions: TerminalReleaseTestRuntimeSnapshot["sessions"][];
} = { capabilities: [], sessions: [] };

/** Records one sanitized, bounded runtime observation for packaged release proof. */
export function recordTerminalReleaseTestRuntime(
  runtime: TerminalReleaseTestRuntime,
): TerminalReleaseTestRuntimeSnapshot {
  const capabilities = {
    contractVersion: runtime.capabilities.contractVersion,
    backend: runtime.capabilities.backend,
    ...(runtime.capabilities.contractVersion === 1
      ? {
          host: {
            state: runtime.capabilities.host.state,
            generation: runtime.capabilities.host.generation,
          },
        }
      : {}),
    ...(runtime.capabilities.contractVersion === 1 && runtime.capabilities.releaseTest
      ? { releaseTest: { hostPid: runtime.capabilities.releaseTest.hostPid } }
      : {}),
  } as TerminalReleaseTestRuntimeSnapshot["capabilities"];
  const sessions = runtime.sessions.slice(0, 64).map((session) => ({
    sessionId: session.sessionId,
    state: session.state,
    hostGeneration: session.hostGeneration,
    exitReason: session.exit?.reason ?? null,
  }));
  runtimeHistory.capabilities.push(capabilities);
  runtimeHistory.sessions.push(sessions);
  runtimeHistory.capabilities.splice(64);
  runtimeHistory.sessions.splice(64);
  return {
    capabilities,
    capabilityHistory: [...runtimeHistory.capabilities],
    sessions,
    sessionHistory: [...runtimeHistory.sessions],
  };
}

/** Reads bounded semantic state from xterm's active buffer for release proof. */
export function readTerminalReleaseTestSnapshot(
  terminal: Terminal,
): TerminalReleaseTestSnapshot {
  const active = terminal.buffer.active;
  const lineCount = Math.min(active.length, 1_024);
  const lines = Array.from({ length: lineCount }, (_, index) => {
    const line = active.getLine(index);
    const text = line?.translateToString(true).replace(/\r/g, "") ?? "";
    return {
      text,
      wrapped: line?.isWrapped === true,
    };
  });
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    cursor: { x: active.cursorX, y: active.cursorY },
    lines,
    normalizedLines: lines.map(({ text }) => text.trimEnd()),
  };
}
