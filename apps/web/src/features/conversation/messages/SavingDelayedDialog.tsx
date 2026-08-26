import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** Props for {@link SavingDelayedDialog}. */
export interface SavingDelayedDialogProps {
  open: boolean;
  onStopSafely: () => Promise<void>;
  onContinueWithoutSaving: () => Promise<void>;
}

/** Requires an explicit user choice when the active response can no longer be retained normally. */
export function SavingDelayedDialog({
  open,
  onStopSafely,
  onContinueWithoutSaving,
}: SavingDelayedDialogProps) {
  const [pending, setPending] = useState<"stop" | "continue" | null>(null);

  const runAction = async (
    action: "stop" | "continue",
    execute: () => Promise<void>,
  ): Promise<void> => {
    setPending(action);
    try {
      await execute();
    } catch {
      setPending(null);
    }
  };

  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Saving is delayed</DialogTitle>
          <DialogDescription>
            Mcode cannot save the latest response. Stop safely keeps saved work. Continue without saving keeps this response visible, but a restart can lose it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void runAction("stop", onStopSafely)}
          >
            Stop safely
          </Button>
          <Button
            type="button"
            disabled={pending !== null}
            onClick={() => void runAction("continue", onContinueWithoutSaving)}
          >
            Continue without saving
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
