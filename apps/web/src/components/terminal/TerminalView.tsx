import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
// Static import so bundler deduplicates the stylesheet
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  readonly ptyId: string;
  readonly visible: boolean;
}

export function TerminalView({ ptyId, visible }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Mount terminal
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;

    async function init(el: HTMLElement) {
      const [{ Terminal: XTerminal }, { FitAddon: XFitAddon }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);

      if (disposed || !containerRef.current) return;

      const term = new XTerminal({
        scrollback: 500,
        fontSize: 13,
        fontFamily: "monospace",
        theme: {
          background: "#0a0a0f",
          foreground: "#e4e4e7",
          cursor: "#e4e4e7",
        },
      });

      const fitAddon = new XFitAddon();
      term.loadAddon(fitAddon);
      term.open(el);
      fitAddon.fit();

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      // Forward keystrokes to the backend
      const dataDisposable = term.onData((data) => {
        window.electronAPI?.invoke("pty:write", ptyId, data);
      });

      // Listen for pty output
      const removePtyData = window.electronAPI?.on(
        "pty:data",
        (...args: unknown[]) => {
          const payload = args[0] as { ptyId: string; data: string };
          if (payload.ptyId === ptyId && typeof payload.data === "string") {
            term.write(payload.data);
          }
        },
      );

      // Listen for pty exit
      const removePtyExit = window.electronAPI?.on(
        "pty:exit",
        (...args: unknown[]) => {
          const payload = args[0] as { ptyId: string; exitCode: number };
          if (payload.ptyId === ptyId) {
            term.write(
              `\r\n\x1b[90m[Process exited with code ${payload.exitCode}]\x1b[0m\r\n`,
            );
          }
        },
      );

      // Auto-fit on resize
      const observer = new ResizeObserver(() => {
        if (!disposed && fitAddonRef.current) {
          fitAddonRef.current.fit();
          const dims = fitAddonRef.current.proposeDimensions();
          if (dims && dims.cols > 0 && dims.rows > 0) {
            window.electronAPI?.invoke(
              "pty:resize",
              ptyId,
              dims.cols,
              dims.rows,
            );
          }
        }
      });
      observer.observe(el);

      const cleanup = () => {
        dataDisposable.dispose();
        removePtyData?.();
        removePtyExit?.();
        observer.disconnect();
        term.dispose();
      };

      // Set cleanupRef BEFORE the disposed check so the effect's
      // synchronous teardown can always reach it, even if it races
      // with this async init completing.
      cleanupRef.current = cleanup;

      if (disposed) {
        cleanup();
        cleanupRef.current = null;
        return;
      }
    }

    init(container);

    return () => {
      disposed = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [ptyId]);

  // Re-fit when visibility changes (ResizeObserver handles the rest)
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      fitAddonRef.current.fit();
    }
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ display: visible ? "block" : "none" }}
    />
  );
}
