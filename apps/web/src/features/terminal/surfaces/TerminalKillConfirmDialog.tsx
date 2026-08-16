import { memo, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** Props for {@link TerminalKillConfirmDialog}. */
export interface TerminalKillConfirmDialogProps {
  /** Whether the dialog is open. */
  readonly open: boolean;
  /** Shell or terminal group being closed. */
  readonly targetName?: string;
  /** Whether process-tree termination is in progress. */
  readonly pending?: boolean;
  /** Called when the user confirms the kill. */
  readonly onConfirm: () => void;
  /** Called when the user cancels or the dialog is dismissed. */
  readonly onCancel: () => void;
}

/**
 * Confirmation dialog shown when `terminal.behavior.confirmOnKill` requires it and
 * the target PTY has live child processes. Presents "Kill anyway" and
 * "Cancel" actions.
 */
export const TerminalKillConfirmDialog = memo(function TerminalKillConfirmDialog({
  open,
  targetName = "terminal",
  pending = false,
  onConfirm,
  onCancel,
}: TerminalKillConfirmDialogProps) {
  const handleOpenChange = useCallback(
    (isOpen: boolean, eventDetails: { cancel: () => void }) => {
      if (isOpen) return;
      if (pending) {
        eventDetails.cancel();
        return;
      }
      onCancel();
    },
    [onCancel, pending],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm" showCloseButton={!pending}>
        <div className="space-y-3">
          <DialogTitle className="text-sm font-medium">
            Close {targetName}?
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            This will terminate the entire process tree, including every running child process.
          </DialogDescription>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
              {pending ? "Closing..." : "Close process tree"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
