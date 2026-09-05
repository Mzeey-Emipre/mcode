import { useThreadStore } from "@/stores/threadStore";

/** Session diagnostics stay outside the paginated turn transcript. */
export function SessionDiagnostics({ threadId }: { readonly threadId: string }) {
  const notices = useThreadStore((state) => state.records.get(threadId)?.sessionNotices);
  if (!notices?.length) return null;
  const hasSecurityWarning = notices.some((notice) => notice.systemNotice?.kind === "security");
  return (
    <details open={hasSecurityWarning} className="mx-4 mt-2 rounded-md border border-border px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium">{hasSecurityWarning ? "Session security warnings and diagnostics" : "Session diagnostics"} ({notices.length})</summary>
      <ul className="mt-2 max-h-48 space-y-2 overflow-auto" aria-label="Session diagnostics">
        {notices.map((notice) => {
          const location = notice.systemNotice?.configRange;
          return <li key={notice.id} className="break-words">
            {notice.systemNotice?.origin === "unattributed-thread" && <p className="font-medium">Unlinked provider thread</p>}
            {notice.systemNotice?.kind === "security" && <p role="alert" className="font-medium text-destructive">Security warning</p>}
            <p>{notice.content}</p>
            {notice.systemNotice?.configPath && <p className="font-mono text-muted-foreground">{notice.systemNotice.configPath}</p>}
            {location && <p className="text-muted-foreground">Lines {location.startLine}:{location.startColumn} to {location.endLine}:{location.endColumn}</p>}
          </li>;
        })}
      </ul>
    </details>
  );
}
