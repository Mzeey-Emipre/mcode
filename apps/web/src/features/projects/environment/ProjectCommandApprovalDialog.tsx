import { useState } from "react";
import type { WorkspaceEnvironmentCommandApproval } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ProjectCommandApprovalDialogProps {
  readonly approval: WorkspaceEnvironmentCommandApproval | null;
  readonly script: string | null;
  readonly onApprove: () => Promise<boolean>;
  readonly onCancel: () => void;
}

/** Shows the exact shared command that must be approved before it can start. */
export function ProjectCommandApprovalDialog({ approval, script, onApprove, onCancel }: ProjectCommandApprovalDialogProps) {
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!approval || !script) return null;

  const approve = async () => {
    setApproving(true);
    setError(null);
    try {
      if (await onApprove()) onCancel();
    } catch (nextError) {
      setError(isProjectCommandApprovalStale(nextError)
        ? "The shared command changed. Review the updated command before trying again."
        : "The shared command could not be approved. Review it again.");
    } finally {
      setApproving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !approving) onCancel(); }}>
      <DialogContent showCloseButton={!approving} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Approve shared command</DialogTitle>
          <DialogDescription>
            This command is stored in the Project checkout. Review the exact command before it runs.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea
          className="max-h-64 rounded-md bg-muted"
          viewportProps={{ tabIndex: 0, "aria-label": "Resolved shared command" }}
        >
          <pre className="p-3 font-mono text-xs whitespace-pre-wrap break-words">{script}</pre>
        </ScrollArea>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={approving} onClick={onCancel}>Cancel</Button>
          <Button type="button" disabled={approving} onClick={() => { void approve(); }}>
            {approving ? "Approving..." : "Approve and run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Returns whether a shared-command approval no longer matches the current command. */
export function isProjectCommandApprovalStale(error: unknown): boolean {
  return approvalErrorCode(error) === "WORKSPACE_ENVIRONMENT_APPROVAL_STALE";
}

/** Returns whether the user must resolve a changed shared command before approval can continue. */
export function isProjectCommandApprovalInvalid(error: unknown): boolean {
  const code = approvalErrorCode(error);
  return code === "WORKSPACE_ENVIRONMENT_APPROVAL_STALE"
    || code === "WORKSPACE_ENVIRONMENT_APPROVAL_NOT_REQUIRED";
}

function approvalErrorCode(error: unknown): unknown {
  return typeof error === "object"
    && error !== null
    && "code" in error
    ? (error as { readonly code?: unknown }).code
    : null;
}
