import { useCallback, useEffect, useRef, useState } from "react";
import { useToastStore } from "@/stores/toastStore";
import { Terminal } from "lucide-react";
import { useTerminalStore, type TerminalInstance } from "@/features/terminal/state/terminalStore";
import { getTransport } from "@/transport";
import { Button } from "@/components/ui/button";
import { TerminalList } from "./TerminalList";
import { TerminalKillConfirmDialog } from "./TerminalKillConfirmDialog";

const EMPTY_TERMINALS: readonly TerminalInstance[] = [];

type PendingClose =
  | { readonly kind: "one"; readonly ptyId: string; readonly name: string; readonly trigger: HTMLButtonElement }
  | { readonly kind: "all"; readonly name: string; readonly trigger: HTMLButtonElement };

const {
  addTerminal: storeAddTerminal,
  removeTerminal: storeRemoveTerminal,
  removeAllTerminals,
} = useTerminalStore.getState();

/** Props for {@link TerminalTabContent}. */
interface TerminalTabContentProps {
  /** The thread whose terminals to display. */
  readonly threadId: string;
}

/**
 * Terminal chrome in the right panel (list, empty state, kill dialog).
 * xterm instances are rendered by {@link TerminalPoolHost} into the right-panel
 * {@link TerminalPoolSlot} (mounted by the right panel terminal tab layer).
 */
export function TerminalTabContent({ threadId }: TerminalTabContentProps) {
  const terminals = useTerminalStore(
    (s) => (s.terminals[threadId] ?? EMPTY_TERMINALS),
  );
  const hasTerminals = terminals.length > 0;

  const [pendingKill, setPendingKill] = useState<PendingClose | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  /** Bumped on thread change so stale async kill confirmations are ignored. */
  const opGenRef = useRef(0);

  useEffect(() => {
    opGenRef.current += 1;
    // oxlint-disable-next-line react/set-state-in-effect -- A global thread change invalidates pending terminal actions.
    setPendingKill(null);
    setIsClosing(false);
  }, [threadId]);

  /** Creates a new terminal for the thread. */
  const createTerminal = useCallback(async () => {
    try {
      const transport = getTransport();
      const { ptyId, shell } = await transport.terminalCreate(threadId);
      storeAddTerminal(threadId, ptyId, shell);
    } catch (err) {
      console.error("[terminal] Failed to create terminal", err);
      const message =
        err instanceof Error ? err.message : "Could not create terminal";
      useToastStore.getState().show("error", "Failed to create terminal", message);
    }
  }, [threadId]);

  /** Immediate kill without guard. Waits for server RPC before evicting local state. */
  const doCloseTerminal = useCallback(async (ptyId: string): Promise<boolean> => {
    try {
      await getTransport().terminalKill(ptyId);
      storeRemoveTerminal(ptyId);
      return true;
    } catch (err) {
      console.error("[terminal] Failed to kill terminal", ptyId, err);
      return false;
    }
  }, []);

  /** Kill with optional confirmation. */
  const closeTerminal = useCallback(
    (ptyId: string, trigger: HTMLButtonElement) => {
      const terminal = terminals.find((candidate) => candidate.id === ptyId);
      if (!terminal) return;
      const opGen = opGenRef.current;
      getTransport()
        .terminalHasChildren(ptyId)
        .then(({ hasChildren }) => {
          if (opGen !== opGenRef.current) return;
          if (!hasChildren) {
            void doCloseTerminal(ptyId);
            return;
          }
          setPendingKill({ kind: "one", ptyId, name: terminal.label, trigger });
        })
        .catch(() => {
          if (opGen !== opGenRef.current) return;
          setPendingKill({ kind: "one", ptyId, name: terminal.label, trigger });
        });
    },
    [terminals, doCloseTerminal],
  );

  /** Immediate kill-all without guard. Waits for server RPC before evicting local state. */
  const doCloseAllTerminals = useCallback(async (): Promise<boolean> => {
    try {
      await getTransport().terminalKillByThread(threadId);
      removeAllTerminals(threadId);
      return true;
    } catch (err) {
      console.error("[terminal] Failed to kill terminals for thread", threadId, err);
      return false;
    }
  }, [threadId]);

  /** Kill-all with optional confirmation. */
  const closeAllTerminals = useCallback((trigger: HTMLButtonElement) => {
    if (terminals.length === 0) {
      void doCloseAllTerminals();
      return;
    }
    const transport = getTransport();
    const opGen = opGenRef.current;
    void Promise.all(
      terminals.map((term) =>
        transport
          .terminalHasChildren(term.id)
          .then(({ hasChildren }) => hasChildren)
          .catch(() => true),
      ),
    ).then((results) => {
      if (opGen !== opGenRef.current) return;
      if (!results.some(Boolean)) {
        void doCloseAllTerminals();
        return;
      }
      setPendingKill({ kind: "all", name: `${terminals.length} terminals`, trigger });
    });
  }, [terminals, doCloseAllTerminals]);

  const confirmKill = useCallback(async () => {
    if (!pendingKill || isClosing) return;
    const operation = pendingKill;
    setIsClosing(true);
    try {
      const closed = operation.kind === "one"
        ? await doCloseTerminal(operation.ptyId)
        : await doCloseAllTerminals();
      if (closed) {
        setPendingKill((current) => current === operation ? null : current);
      }
    } finally {
      setIsClosing(false);
    }
  }, [pendingKill, isClosing, doCloseTerminal, doCloseAllTerminals]);

  const cancelKill = useCallback(() => {
    const trigger = pendingKill?.trigger ?? null;
    setPendingKill(null);
    window.setTimeout(() => trigger?.focus(), 0);
  }, [pendingKill]);

  return (
    <>
      <TerminalKillConfirmDialog
        open={pendingKill !== null}
        targetName={pendingKill?.name ?? "terminal"}
        pending={isClosing}
        onConfirm={confirmKill}
        onCancel={cancelKill}
      />

      {hasTerminals ? (
        <TerminalList
          threadId={threadId}
          onClose={closeTerminal}
          onAdd={createTerminal}
          onDeleteAll={closeAllTerminals}
        />
      ) : (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
          <Terminal className="h-10 w-10 opacity-40" />
          <p className="text-sm">No terminals</p>
          <Button variant="outline" size="sm" onClick={createTerminal}>
            New terminal
          </Button>
        </div>
      )}
    </>
  );
}
