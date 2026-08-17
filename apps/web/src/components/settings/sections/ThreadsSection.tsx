import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getTransport } from "@/transport";
import { useSettingsStore } from "@/stores/settingsStore";
import type { UnsafeWorktreePolicy } from "@mcode/contracts";
import { SectionHeading } from "../SectionHeading";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";

const DEFAULT_RETENTION_DAYS = 3;

/** Settings for completed-thread retention and automatic deletion. */
export function ThreadsSection() {
  const retentionDays = useSettingsStore(
    (state) => state.settings.thread.completion.retentionDays,
  );
  const update = useSettingsStore((state) => state.update);
  const unsafeWorktreePolicy = useSettingsStore(
    (state) => state.settings.thread.completion.unsafeWorktreePolicy,
  );
  const lastValidDays = useRef(retentionDays ?? DEFAULT_RETENTION_DAYS);
  const [draft, setDraft] = useState(String(lastValidDays.current));
  const [error, setError] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [blockedDeleteCount, setBlockedDeleteCount] = useState<number | null>(null);
  const [isCheckingBlockedCount, setIsCheckingBlockedCount] = useState(false);
  const policyCheckInFlight = useRef(false);

  useEffect(() => {
    if (retentionDays === null) return;
    lastValidDays.current = retentionDays;
    setDraft(String(retentionDays));
    setError(null);
  }, [retentionDays]);

  const commitDraft = () => {
    const trimmed = draft.trim();
    const parsed = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
      setError("Enter a whole number from 1 to 365.");
      return;
    }
    lastValidDays.current = parsed;
    setDraft(String(parsed));
    setError(null);
    if (retentionDays !== parsed) {
      void update({ thread: { completion: { retentionDays: parsed } } });
    }
  };

  const automaticDeletionDisabled = retentionDays === null;

  const saveUnsafeWorktreePolicy = async (value: UnsafeWorktreePolicy) => {
    try {
      await update({
        thread: { completion: { unsafeWorktreePolicy: value } },
      });
      return true;
    } catch (cause: unknown) {
      setPolicyError(`Could not save unsafe cleanup policy: ${String(cause)}`);
      return false;
    }
  };

  const handleUnsafeWorktreePolicyChange = (value: string) => {
    const nextPolicy = value as UnsafeWorktreePolicy;
    if (policyCheckInFlight.current) return;
    if (nextPolicy === unsafeWorktreePolicy) return;
    setPolicyError(null);

    if (unsafeWorktreePolicy === "block" && nextPolicy === "delete") {
      policyCheckInFlight.current = true;
      setIsCheckingBlockedCount(true);
      void getTransport()
        .countBlockedThreadCleanupCandidates()
        .then(({ count }) => {
          if (count > 0) {
            setBlockedDeleteCount(count);
            return;
          }
          return saveUnsafeWorktreePolicy(nextPolicy);
        })
        .catch((cause: unknown) => {
          setPolicyError(`Could not check blocked cleanup candidates: ${String(cause)}`);
        })
        .finally(() => {
          policyCheckInFlight.current = false;
          setIsCheckingBlockedCount(false);
        });
      return;
    }

    void saveUnsafeWorktreePolicy(nextPolicy);
  };

  const confirmUnsafeDeletion = async () => {
    if (blockedDeleteCount === null) return;
    setPolicyError(null);
    if (await saveUnsafeWorktreePolicy("delete")) {
      setBlockedDeleteCount(null);
    }
  };

  return (
    <div>
      <SectionHeading>Threads</SectionHeading>
      <SettingRow
        label="Completed thread retention"
        configKey="thread.completion.retentionDays"
        hint="Changes apply to existing completed threads. A shorter period gives newly overdue threads 24 hours before cleanup."
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Input
              aria-label="Completed thread retention days"
              aria-describedby={error ? "completed-thread-retention-error" : undefined}
              aria-invalid={error ? true : undefined}
              type="number"
              min={1}
              max={365}
              step={1}
              value={draft}
              disabled={automaticDeletionDisabled}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              onBlur={commitDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setDraft(String(lastValidDays.current));
                  setError(null);
                  event.currentTarget.blur();
                }
              }}
              className="w-20 font-mono tabular-nums"
            />
            <span className="text-sm text-muted-foreground">days</span>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="completed-thread-retention-never"
              checked={automaticDeletionDisabled}
              onCheckedChange={(checked) => {
                setError(null);
                if (checked) {
                  void update({ thread: { completion: { retentionDays: null } } });
                  return;
                }
                setDraft(String(lastValidDays.current));
                void update({
                  thread: { completion: { retentionDays: lastValidDays.current } },
                });
              }}
            />
            <label
              htmlFor="completed-thread-retention-never"
              className="text-sm text-foreground"
            >
              <span aria-hidden>Never</span>
              <span className="sr-only">Never delete completed threads automatically</span>
            </label>
          </div>
          {error ? (
            <p
              id="completed-thread-retention-error"
              role="alert"
              className="basis-full text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
        </div>
      </SettingRow>
      <SettingRow
        label="Unsafe worktree cleanup"
        configKey="thread.completion.unsafeWorktreePolicy"
        hint="Block protects worktrees with uncommitted files or unique branchless commits. Delete can discard those files and commits after confirmation."
      >
        <div className="flex flex-wrap items-center gap-3" aria-busy={isCheckingBlockedCount}>
          <SegControl
            options={[
              { value: "block", label: "Block" },
              { value: "delete", label: "Delete" },
            ]}
            value={unsafeWorktreePolicy}
            onChange={handleUnsafeWorktreePolicyChange}
          />
          {policyError ? (
            <p role="alert" className="basis-full text-xs text-destructive">
              {policyError}
            </p>
          ) : null}
        </div>
      </SettingRow>

      <Dialog
        open={blockedDeleteCount !== null}
        onOpenChange={(open) => {
          if (!open) setBlockedDeleteCount(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Allow unsafe cleanup?</DialogTitle>
            <DialogDescription>
              There are {blockedDeleteCount} blocked completed threads. Delete can discard
              uncommitted files and unique branchless commits in their worktrees. This
              action will requeue all {blockedDeleteCount} candidates.
            </DialogDescription>
          </DialogHeader>
          {policyError ? (
            <p role="alert" className="text-xs text-destructive">
              {policyError}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBlockedDeleteCount(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmUnsafeDeletion()}>
              Allow deletion
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
