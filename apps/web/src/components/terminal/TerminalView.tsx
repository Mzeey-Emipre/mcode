import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

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
          // CSS import has no type declarations; ignore the type error
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error css module import
          import("@xterm/xterm/css/xterm.css"),
        ]);

      if (disposed) return;

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
        (id: unknown, data: unknown) => {
          if (id === ptyId && typeof data === "string") {
            term.write(data);
          }
        },
      );

      // Listen for pty exit
      const removePtyExit = window.electronAPI?.on(
        "pty:exit",
        (id: unknown, exitCode: unknown) => {
          if (id === ptyId) {
            term.writeln(
              `\r\n[Process exited with code ${exitCode ?? "unknown"}]`,
            );
          }
        },
      );

      // Auto-fit on resize
      const observer = new ResizeObserver(() => {
        if (!disposed && fitAddonRef.current) {
          fitAddonRef.current.fit();
          const dims = fitAddonRef.current.proposeDimensions();
          if (dims) {
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

      cleanupRef.current = () => {
        dataDisposable.dispose();
        removePtyData?.();
        removePtyExit?.();
        observer.disconnect();
        term.dispose();
      };
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

  // Re-fit when visibility changes
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      // Delay fit slightly to let the container dimensions settle
      const timer = setTimeout(() => {
        fitAddonRef.current?.fit();
      }, 0);
      return () => clearTimeout(timer);
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
