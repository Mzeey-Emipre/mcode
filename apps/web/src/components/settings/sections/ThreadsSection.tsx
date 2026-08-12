import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settingsStore";
import { SectionHeading } from "../SectionHeading";
import { SettingRow } from "../SettingRow";

const DEFAULT_RETENTION_DAYS = 3;

/** Settings for completed-thread retention and automatic deletion. */
export function ThreadsSection() {
  const retentionDays = useSettingsStore(
    (state) => state.settings.thread.completion.retentionDays,
  );
  const update = useSettingsStore((state) => state.update);
  const lastValidDays = useRef(retentionDays ?? DEFAULT_RETENTION_DAYS);
  const [draft, setDraft] = useState(String(lastValidDays.current));
  const [error, setError] = useState<string | null>(null);

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
    </div>
  );
}
