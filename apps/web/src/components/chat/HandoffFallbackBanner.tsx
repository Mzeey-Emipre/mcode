/**
 * Banner shown at the top of a child fork thread when the handoff was produced
 * by the local deterministic path (path D) because the provider was unavailable
 * or the pipeline threw.
 *
 * Copy varies based on the classified provider error so users understand what
 * actually happened and what (if anything) they should do.
 *
 * Suppressed when `chat.handoff.notifyOnLocalFallback` is false.
 * The "Regenerate" button is a v1 stub; live regeneration is deferred.
 */

import { useState, useEffect } from "react";
import { AlertCircle, RotateCcw, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import type { HandoffMeta } from "@/stores/threadStore";
import { getTransport } from "@/transport";
import { MarkdownContent } from "./MarkdownContent";

/** Props for {@link HandoffFallbackBanner}. */
interface Props {
  /** ID of the child fork thread to check handoff status for. */
  threadId: string;
}

/**
 * Resolved banner copy lines for a given handoff metadata state.
 * `title` is the prominent line; `sub` is the smaller secondary explanation.
 */
interface BannerCopy {
  title: string;
  sub: string;
}

/**
 * Pick copy based on the classified provider error that caused the local fallback.
 * A null `providerErrorOnGenerate` means path D fired for a structural reason (no
 * session, provider doesn't support fork handoffs) rather than a runtime error.
 */
function bannerCopy(meta: HandoffMeta): BannerCopy {
  switch (meta.providerErrorOnGenerate) {
    case "quota":
      return {
        title: "Your previous provider was rate-limited.",
        sub: "Used the local builder for this handoff. Retry will be available later.",
      };
    case "auth":
      return {
        title: "Your previous provider returned an auth error.",
        sub: "Used the local builder. Check your provider credentials in settings.",
      };
    case "context-overflow":
      return {
        title: "Your previous thread is too large for a side-channel handoff.",
        sub: "Used the local builder, which summarizes within budget.",
      };
    case "transient":
      return {
        title: "Couldn't reach your previous provider for the handoff.",
        sub: "Used the local builder. The next fork will retry the provider.",
      };
    case "fatal":
      return {
        title: "Previous provider returned an unexpected error.",
        sub: "Used the local builder for this handoff.",
      };
    default:
      // providerErrorOnGenerate is null or absent: structural reason, not a runtime error.
      return {
        title: "Used the local builder for this handoff.",
        sub: "Your previous thread hadn't started a provider session, or that provider doesn't support fork handoffs.",
      };
  }
}

/** Strips YAML frontmatter delimited by leading `---` lines from markdown. */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** The content rendered inside the handoff doc viewer dialog. */
function HandoffDocViewer({ threadId }: { threadId: string }) {
  const [state, setState] = useState<
    | { threadId: string; phase: "loading" }
    | { threadId: string; phase: "ready"; markdown: string; meta: NonNullable<Awaited<ReturnType<ReturnType<typeof getTransport>["readLatestHandoff"]>>>["meta"] }
    | { threadId: string; phase: "error"; message: string }
  >({ threadId, phase: "loading" });

  // Fetch on mount. The dialog mounts only when open=true.
  useEffect(() => {
    let cancelled = false;
    getTransport()
      .readLatestHandoff(threadId)
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setState({ threadId, phase: "error", message: "No handoff document found for this thread." });
        } else {
          setState({ threadId, phase: "ready", markdown: result.markdown, meta: result.meta });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          threadId,
          phase: "error",
          message: err instanceof Error ? err.message : "Failed to load handoff document.",
        });
      });
    return () => { cancelled = true; };
  }, [threadId]);

  const viewState = state.threadId === threadId ? state : { threadId, phase: "loading" as const };

  if (viewState.phase === "loading") {
    return <p className="text-muted-foreground text-sm py-4">Loading...</p>;
  }
  if (viewState.phase === "error") {
    return <p className="text-destructive text-sm py-4">{viewState.message}</p>;
  }

  const { meta } = viewState;
  return (
    <div className="flex flex-col gap-3 overflow-hidden">
      {/* Metadata strip: key fields at a glance without wading into the doc body */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground border-b pb-3">
        <div><span className="font-mono">ladderStep:</span> {meta.ladderStep}</div>
        <div><span className="font-mono">mode:</span> {meta.mode}</div>
        <div><span className="font-mono">generatedBy:</span> {meta.generatedBy}</div>
        {meta.provider && <div><span className="font-mono">provider:</span> {meta.provider}</div>}
        <div><span className="font-mono">chars:</span> {meta.characterCount.toLocaleString()}</div>
        <div><span className="font-mono">when:</span> {new Date(meta.generatedAt).toLocaleString()}</div>
      </div>
      <div className="overflow-y-auto max-h-[65vh]">
        <MarkdownContent content={stripFrontmatter(viewState.markdown)} />
      </div>
    </div>
  );
}

/**
 * Renders an amber warning banner when the fork's handoff document was produced
 * locally rather than by the AI provider. Hidden when the notification setting
 * is disabled or the thread's handoff status is not "fallback".
 */
export function HandoffFallbackBanner({ threadId }: Props) {
  const enabled = useSettingsStore(
    (s) => s.settings.chat?.handoff?.notifyOnLocalFallback ?? true,
  );
  const meta = useThreadRecord(threadId, (r) => r.handoffMeta);
  const setHandoffStatus = useThreadStore((s) => s.setHandoffStatus);
  const [docOpen, setDocOpen] = useState(false);

  if (!enabled || meta?.status !== "fallback") return null;

  const copy = bannerCopy(meta);

  return (
    <>
      <div
        role="status"
        data-testid="handoff-fallback-banner"
        className="flex items-start gap-3 border-b border-border bg-muted/40 px-4 py-2 text-sm"
      >
        <AlertCircle className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" aria-hidden />
        <span className="flex-1 min-w-0">
          <span className="font-medium text-foreground/80">{copy.title}</span>
          <span className="block text-xs text-muted-foreground mt-0.5">{copy.sub}</span>
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDocOpen(true)}
            className="gap-1 text-xs h-7"
          >
            <FileText className="h-3 w-3" />
            View doc
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled
                    className="gap-1 h-7"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Regenerate
                  </Button>
                </span>
              }
            />
            <TooltipContent>Coming soon</TooltipContent>
          </Tooltip>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setHandoffStatus(threadId, "ready")}
            aria-label="Dismiss"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Dialog open={docOpen} onOpenChange={setDocOpen}>
        <DialogContent className="max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden">
          <DialogTitle>Handoff document</DialogTitle>
          {docOpen && <HandoffDocViewer threadId={threadId} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
