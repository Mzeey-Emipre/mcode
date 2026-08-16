import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, ExternalLink, Square, X } from "lucide-react";
import type {
  ThreadControlIdentity,
  ThreadControlProjection,
  ThreadControlRelation,
  ThreadControlThreadRef,
  ThreadObservedState,
} from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  ClaudeIcon,
  CodexIcon,
  CopilotIcon,
  CursorProviderIcon,
  GeminiIcon,
  OpenCodeIcon,
} from "@/components/chat/ProviderIcons";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { threadControlKey, useThreadControlStore } from "@/stores/threadControlStore";

const STATUS_LABELS: Record<ThreadObservedState["status"], string> = {
  starting: "Created",
  running: "Running",
  idle: "Idle",
  waiting_for_approval: "Waiting for approval",
  waiting_for_user: "Waiting for user",
  failed: "Failed",
  stopped: "Stopped",
  completed: "Completed",
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  gemini: "Gemini",
  opencode: "OpenCode",
};

function ProviderIcon({ providerId }: { readonly providerId: string }) {
  const props = { size: 14, className: "shrink-0" };
  switch (providerId) {
    case "claude": return <ClaudeIcon {...props} />;
    case "codex": return <CodexIcon {...props} />;
    case "copilot": return <CopilotIcon {...props} />;
    case "cursor": return <CursorProviderIcon {...props} />;
    case "gemini": return <GeminiIcon {...props} />;
    case "opencode": return <OpenCodeIcon {...props} />;
    default: return <span aria-hidden className="size-3.5 rounded-full border border-muted-foreground/60" />;
  }
}

function statusLabel(state: ThreadObservedState): string {
  return state.status === "waiting_for_approval"
    ? `${STATUS_LABELS[state.status]} (${state.approvalId})`
    : STATUS_LABELS[state.status];
}

function threadName(ref: ThreadControlThreadRef | null): string {
  return ref?.title ?? "Unknown thread";
}

async function navigateToThread(ref: ThreadControlThreadRef): Promise<void> {
  const workspace = useWorkspaceStore.getState();
  if (workspace.activeWorkspaceId !== ref.workspaceId) {
    workspace.setActiveWorkspace(ref.workspaceId, undefined, false);
    await workspace.loadThreads(ref.workspaceId);
  } else if (!workspace.threads.some((thread) => thread.id === ref.threadId)) {
    await workspace.loadThreads(ref.workspaceId);
  }
  useWorkspaceStore.getState().setActiveThread(ref.threadId);
}

function RelationCard({
  relation,
  sourceIdentity,
  onRefresh,
}: {
  readonly relation: ThreadControlRelation;
  readonly sourceIdentity: ThreadControlIdentity;
  readonly onRefresh: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const destination = relation.destination;
  const destinationState = statusLabel(destination.state);
  const canStop = destination.state.status === "starting"
    || destination.state.status === "running"
    || destination.state.status === "waiting_for_user";
  const canSend = destination.state.status === "starting"
    || destination.state.status === "idle"
    || destination.state.status === "waiting_for_user";

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy(true);
    try {
      await getTransport().sendThreadControl({
        source: sourceIdentity,
        target: { workspaceId: destination.workspaceId, threadId: destination.threadId },
        message,
      });
      setDraft("");
      setComposerOpen(false);
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await getTransport().stopThreadControl({
        source: sourceIdentity,
        target: { workspaceId: destination.workspaceId, threadId: destination.threadId },
      });
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="border-b border-border/50 px-4 py-3" data-testid="coordination-relation">
      <div className="flex items-start gap-2">
        <ProviderIcon providerId={destination.providerId} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="min-w-0 truncate px-0 text-left text-sm font-medium"
              onClick={() => void navigateToThread(destination)}
              aria-label={`Open destination Project and thread ${destination.title}`}
            >
              {destination.title}
            </Button>
            <Badge variant="outline" className="shrink-0 text-[11px]" aria-label={`Status: ${destinationState}`}>
              {destinationState}
            </Badge>
          </div>
          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <span>{PROVIDER_LABELS[destination.providerId] ?? destination.providerId}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{destination.workspaceId}</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void navigateToThread(destination)}>
              <ExternalLink size={13} aria-hidden />
              Open thread
            </Button>
            {canSend && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setComposerOpen((open) => !open)}>
                <ArrowRight size={13} aria-hidden />
                Send follow-up
              </Button>
            )}
            {canStop && (
              <Button type="button" variant="ghost" size="sm" onClick={() => void stop()} disabled={busy}>
                <Square size={13} aria-hidden />
                Stop
              </Button>
            )}
          </div>
          {composerOpen && (
            <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
              <label className="sr-only" htmlFor={`coordination-message-${destination.threadId}`}>Follow-up message</label>
              <Textarea
                id={`coordination-message-${destination.threadId}`}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Send work to this thread"
                rows={3}
                maxLength={100_000}
                disabled={busy}
              />
              <Button type="submit" size="sm" disabled={busy || draft.trim().length === 0}>
                Send
              </Button>
            </form>
          )}
        </div>
      </div>
    </article>
  );
}

function OriginRow({
  message,
}: {
  readonly message: ThreadControlProjection["messages"][number];
}) {
  if (message.role !== "user") return null;
  const origin = message.origin;
  const source = origin.type === "thread" ? origin.sourceThread : null;
  const sourceUnavailable = origin.type === "thread" && origin.sourceUnavailable;
  const label = origin.type === "composer"
    ? "From composer"
    : origin.type === "thread"
      ? `From ${origin.sourceWorkspaceName} / ${threadName(source)} (${sourceUnavailable ? "source unavailable" : "thread origin"})`
      : "Legacy origin";
  return (
    <div className="border-b border-border/40 px-4 py-2.5" data-testid="coordination-message-origin">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {origin.type === "thread" && <ProviderIcon providerId={origin.sourceProviderId} />}
        <span>{label}</span>
        {source && !sourceUnavailable && (
          <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => void navigateToThread(source)}>
            Open source
          </Button>
        )}
      </div>
      {sourceUnavailable && (
        <p className="mt-1 text-xs text-muted-foreground" role="status">
          Historical source unavailable; navigation disabled.
        </p>
      )}
      <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-foreground">{message.content}</p>
    </div>
  );
}

/** User-facing persisted thread coordination panel. */
export function CoordinationPanel({ workspaceId, threadId }: { readonly workspaceId: string; readonly threadId: string }) {
  const identity = useMemo(() => ({ workspaceId, threadId }), [threadId, workspaceId]);
  const key = threadControlKey(identity);
  const entry = useThreadControlStore((state) => state.entries[key]);
  const load = useThreadControlStore((state) => state.load);
  const projection = entry?.projection ?? null;

  useEffect(() => {
    void load(identity);
  }, [identity, load]);

  const refresh = useCallback(() => { void load(identity, { force: true }); }, [identity, load]);

  if (entry?.loading && !projection) {
    return <section className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground" aria-live="polite">Loading coordination…</section>;
  }
  if (entry?.error && !projection) {
    return <section className="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground" role="alert">{entry.error}</section>;
  }
  if (!projection) return null;

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Thread coordination" data-testid="coordination-panel">
      <header className="flex shrink-0 items-center justify-between border-b border-border/50 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ProviderIcon providerId={projection.thread.providerId} />
            <h2 className="text-sm font-semibold">Coordination</h2>
          </div>
          <p className="text-xs text-muted-foreground">{projection.thread.title}</p>
        </div>
        <Badge variant="outline" aria-live="polite" aria-label={`Current thread status: ${statusLabel(projection.thread.state)}`}>
          {statusLabel(projection.thread.state)}
        </Badge>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        {projection.relation && (
          <section aria-labelledby="coordination-relation-heading">
            <h3 id="coordination-relation-heading" className="px-4 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Delegated from
            </h3>
            <div className="px-4 pb-2">
              {projection.relation.source ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void navigateToThread(projection.relation!.source!)}>
                  <ProviderIcon providerId={projection.relation.source.providerId} />
                  <ExternalLink size={13} aria-hidden />
                  {projection.relation.source.title}
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">Source thread is no longer available.</p>
              )}
            </div>
          </section>
        )}
        {projection.children.length > 0 && (
          <section aria-labelledby="coordination-children-heading">
            <h3 id="coordination-children-heading" className="px-4 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Delegated threads ({projection.children.length})
            </h3>
            {projection.children.map((relation) => (
              <RelationCard key={relation.destination.threadId} relation={relation} sourceIdentity={identity} onRefresh={refresh} />
            ))}
          </section>
        )}
        {projection.approvals.length > 0 && (
          <section aria-labelledby="coordination-approvals-heading">
            <h3 id="coordination-approvals-heading" className="px-4 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Approval requests ({projection.approvals.length})
            </h3>
            {projection.approvals.map((approval) => (
              <div key={approval.requestId} className="border-b border-border/40 px-4 py-3" data-testid="coordination-approval">
                <p className="text-sm font-medium">{approval.title ?? approval.toolName}</p>
                <p className="mt-1 text-xs text-muted-foreground">Owned by {approval.ownerThreadId ?? approval.threadId}</p>
                <div className="mt-2 flex gap-2">
                  <Button type="button" size="sm" onClick={() => void getTransport().respondToPermission(approval.requestId, "allow").then(refresh)}>
                    <Check size={13} aria-hidden />
                    Allow
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void getTransport().respondToPermission(approval.requestId, "deny").then(refresh)}>
                    <X size={13} aria-hidden />
                    Deny
                  </Button>
                </div>
              </div>
            ))}
          </section>
        )}
        <section aria-labelledby="coordination-origins-heading">
          <h3 id="coordination-origins-heading" className="px-4 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Message origins
          </h3>
          {projection.messages.filter((message) => message.role === "user").length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No user messages yet.</p>
          ) : projection.messages.map((message) => (
            <OriginRow key={message.messageId} message={message} />
          ))}
        </section>
      </ScrollArea>
    </section>
  );
}
