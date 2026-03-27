import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { getTransport } from "@/transport";
// Static import so bundler deduplicates the stylesheet
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  readonly ptyId: string;
  readonly visible: boolean;
}

/** Renders a single xterm.js terminal backed by a server-side PTY via WS transport. */
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

      const transport = getTransport();

      // Forward keystrokes to the backend via WS RPC
      const dataDisposable = term.onData((data) => {
        transport.terminalWrite(ptyId, data).catch(() => {});
      });

      // Listen for PTY output via push channel (CustomEvent dispatched by ws-events)
      const handlePtyData = (e: Event) => {
        const detail = (e as CustomEvent).detail as {
          ptyId: string;
          data: string;
        };
        if (detail.ptyId === ptyId && typeof detail.data === "string") {
          term.write(detail.data);
        }
      };
      window.addEventListener("mcode:pty-data", handlePtyData);

      // Listen for PTY exit via push channel
      const handlePtyExit = (e: Event) => {
        const detail = (e as CustomEvent).detail as {
          ptyId: string;
          code: number;
        };
        if (detail.ptyId === ptyId) {
          term.write(
            `\r\n\x1b[90m[Process exited with code ${detail.code}]\x1b[0m\r\n`,
          );
        }
      };
      window.addEventListener("mcode:pty-exit", handlePtyExit);

      // Auto-fit on resize
      const observer = new ResizeObserver(() => {
        if (!disposed && fitAddonRef.current) {
          fitAddonRef.current.fit();
          const dims = fitAddonRef.current.proposeDimensions();
          if (dims && dims.cols > 0 && dims.rows > 0) {
            transport.terminalResize(ptyId, dims.cols, dims.rows).catch(() => {});
          }
        }
      });
      observer.observe(el);

      const cleanup = () => {
        dataDisposable.dispose();
        window.removeEventListener("mcode:pty-data", handlePtyData);
        window.removeEventListener("mcode:pty-exit", handlePtyExit);
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
