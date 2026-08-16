import { memo, useMemo, useState, useCallback, useRef, useEffect, lazy, Suspense, type ReactNode } from "react";
import type { Message } from "@/transport";
import { ImageIcon, RotateCcw, Copy, Check, GitFork, AlertCircle, Reply, Target } from "lucide-react";
import { cn } from "@/lib/utils";
const LazyMarkdownContent = lazy(() => import("@/components/chat/MarkdownContent"));
import { stripInjectedFiles } from "@/lib/file-tags";
import { buildStoredAttachmentImageSrc } from "@/lib/attachment-url";
import { resolveModelDisplayLabel } from "@/lib/format-model-label";
import { useProviderModelsStore } from "@/stores/providerModelsStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { isHandoffMessage, parseHandoffJson } from "@/components/chat/handoff-utils";
import { HandoffCard } from "@/components/chat/HandoffCard";
import { FileAttachmentTile } from "@/components/chat/FileAttachmentTile";
import { ImageAttachmentLightbox } from "@/components/chat/ImageAttachmentLightbox";
import { useThreadRecord } from "../state";
import { AnsweredSummary } from "@/components/chat/plan-questions/AnsweredSummary";
import { PLAN_ANSWER_MESSAGE_PREFIX } from "@mcode/contracts";
import { DeltaBlock } from "../narrative/DeltaBlock";
import { parseGoalStatusNotice } from "@/lib/goal-message";
import { composerFeedbackReplyFallback } from "@/lib/composer-feedback";
import { PreviewAnnotationBundleChip } from "@/components/chat/PreviewAnnotationBundleChip";
import { useRetriableAttachmentImage } from "@/components/chat/useRetriableAttachmentImage";
import { EntityToken } from "@/components/chat/EntityToken";
import { basename } from "@/lib/path";

/**
 * Returns true when the assistant message body collapses to nothing visible
 * after stripping content that other components render (the plan-questions
 * fenced block is consumed by the wizard, so it must not also leave behind
 * an empty assistant bubble — which is what cursor-agent's strict "Output
 * ONLY the plan-questions block" obedience produces).
 */
function isAssistantContentEmpty(content: string): boolean {
  const stripped = content
    .replace(/```plan-questions\n[\s\S]*?```/g, "")
    .replace(/```plan-output\n[\s\S]*?```/g, "");
  return stripped.trim().length === 0;
}

/** Parses the message content of a synthetic agent-error system message. Returns the error text, or null if not an agent error. */
/**
 * Detect a user-typed /goal SET form (`/goal <condition>` with non-empty,
 * non-control argument). The server rewrites the wire payload into a
 * directive and dispatches it to the agent without emitting a separate
 * assistant "Goal set: ..." status message, so the user's bubble shows the
 * stripped objective with a quiet "Sent as goal" footer. Returns null for
 * control forms (clear, reset, show, empty) because those get an assistant
 * receipt from the server.
 */
function parseUserGoalCommand(content: string): { condition: string } | null {
  const m = /^\s*\/goal\b\s*([\s\S]*)$/.exec(content);
  if (!m) return null;
  const arg = m[1].trim();
  if (arg === "") return null;
  const lower = arg.toLowerCase();
  if (lower === "clear" || lower === "reset" || lower === "show") return null;
  return { condition: arg };
}

function MentionedUserText({
  text,
  mentions,
}: {
  text: string;
  mentions: NonNullable<Message["mentions"]>;
}) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  const sorted = [...mentions].sort((a, b) => a.range.start - b.range.start);

  for (const mention of sorted) {
    const rawMention = mention.kind === "command" ? `/${mention.label}` : `@${mention.label}`;
    if (
      mention.range.start < cursor ||
      mention.range.end > text.length ||
      text.slice(mention.range.start, mention.range.end) !== rawMention
    ) {
      continue;
    }
    if (mention.range.start > cursor) {
      nodes.push(text.slice(cursor, mention.range.start));
    }
    nodes.push(
      <EntityToken
        key={`${mention.id}-${mention.range.start}`}
        kind={mention.kind === "command" ? mention.namespace : mention.kind}
        label={
          mention.kind === "command"
            ? rawMention
            : mention.kind === "file"
              ? `@${basename(mention.path)}`
              : rawMention
        }
        filePath={mention.kind === "file" ? mention.path : undefined}
        title={rawMention}
        tone="user"
        invocation={mention.kind === "command"}
      />,
    );
    cursor = mention.range.end;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <p className="mb-2 whitespace-pre-wrap leading-relaxed">{nodes}</p>;
}

/**
 * Compact goal lifecycle receipt: an amber target glyph beside a mono
 * small-caps label, with an optional muted suffix (e.g. a duration). It marks
 * the two bookends of a goal's life in one consistent, legible vocabulary —
 * "Sent as goal" under the user's setting message and "Goal achieved" on the
 * agent side — so neither reads as a throwaway footnote or a faint hairline.
 * Amber is the app's single accent and is sanctioned for state indicators, so
 * the marker catches the glance while staying quiet (no chip, no fill).
 */
function GoalReceipt({
  label,
  suffix,
  tone = "accent",
  className,
}: {
  label: string;
  suffix?: string;
  /**
   * `accent` spends the amber lamp on a noteworthy state (goal achieved);
   * `muted` keeps a routine confirmation (sent as goal) quiet and neutral so
   * the accent stays rationed per the One-Lamp rule.
   */
  tone?: "accent" | "muted";
  className?: string;
}) {
  return (
    <span
      data-testid="goal-receipt"
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-xs font-medium uppercase tracking-[0.18em]",
        tone === "muted" ? "text-muted-foreground" : "text-primary",
        className,
      )}
    >
      <Target size={13} className="shrink-0" aria-hidden="true" />
      <span>{label}</span>
      {suffix && (
        <span className="font-normal normal-case tracking-normal tabular-nums text-muted-foreground/75">
          {suffix}
        </span>
      )}
    </span>
  );
}

/**
 * Hairline chapter-break rendering for /goal command notices. Used by both
 * the user-typed SET form and assistant-emitted SHOW/CLEAR confirmations.
 * Mirrors the existing system-message divider pattern (hairline + glyph +
 * caption) but tinted with the amber `primary` accent so /goal events read
 * as structural marks rather than card chips in the transcript.
 *
 * Layout (collapsed): ─── ◎ GOAL SET "<condition>" /GOAL CLEAR ─── (truncated)
 * Layout (expanded):  ─── ◎ GOAL SET /GOAL CLEAR ───
 *                          "<condition wrapping across multiple lines>"
 *
 * The condition is a button that toggles expansion so long directives stay
 * readable. `dir="auto"` lets the browser pick reading order from the
 * content itself so RTL or mixed-script conditions render naturally.
 * `[overflow-wrap:anywhere]` allows breaking inside long unbroken tokens
 * (URLs, hashes) that ordinary `break-words` would leave to overflow.
 */
function GoalPill({ label, condition, hint }: { label: string; condition?: string; hint?: string }) {
  const [expanded, setExpanded] = useState(false);

  const labelEl = (
    <span className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
      {label}
    </span>
  );
  const hintEl = hint ? (
    <span className="shrink-0 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground/70">
      {hint}
    </span>
  ) : null;
  const iconEl = (
    <Target
      data-testid="target-icon"
      size={12}
      className="shrink-0 self-center text-primary"
      aria-hidden="true"
    />
  );

  if (expanded && condition) {
    return (
      <div
        className="flex items-start gap-3 py-2"
        data-testid="goal-pill"
        data-expanded="true"
        role="note"
        aria-label={`${label}: ${condition}`}
      >
        <div className="mt-2 h-px flex-1 bg-primary/40" />
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <div className="flex items-baseline gap-2.5">
            {iconEl}
            {labelEl}
            {hintEl}
          </div>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-expanded="true"
            aria-label="Collapse goal condition"
            dir="auto"
            className="cursor-pointer text-left font-serif text-sm italic leading-snug text-foreground [overflow-wrap:anywhere] hover:text-foreground/80"
          >
            &ldquo;{condition}&rdquo;
          </button>
        </div>
        <div className="mt-2 h-px flex-1 bg-primary/40" />
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-3 py-2"
      data-testid="goal-pill"
      data-expanded="false"
      role="note"
      aria-label={condition ? `${label}: ${condition}` : label}
    >
      <div className="h-px flex-1 bg-primary/40" />
      <div className="flex min-w-0 items-baseline gap-2.5">
        {iconEl}
        {labelEl}
        {condition && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-expanded="false"
            aria-label="Expand full goal condition"
            title={condition}
            dir="auto"
            className="min-w-0 cursor-pointer truncate text-left font-serif text-sm italic leading-snug text-foreground hover:text-foreground/80"
          >
            &ldquo;{condition}&rdquo;
          </button>
        )}
        {hintEl}
      </div>
      <div className="h-px flex-1 bg-primary/40" />
    </div>
  );
}

function parseAgentError(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { __type?: string; message?: string };
    if (parsed.__type === "agent_error" && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // not JSON
  }
  return null;
}
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Props for {@link MessageBubble}. */
interface MessageBubbleProps {
  /** The message object to render. */
  message: Message;
  /** Controls whether user-message actions such as copy, reply, or fork are available. */
  interactive?: boolean;
  /** Called when the user clicks the branch icon on this message. */
  onBranch?: (messageId: string) => void;
  /** Called when the user clicks the reply button on this message. */
  onReply?: (messageId: string, content: string, role: "user" | "assistant") => void;
  /** Called when the user clicks a quote block to scroll to the original message. */
  onScrollToMessage?: (messageId: string) => void;
  /** Renders assistant content through the live delta adapter for the active turn. */
  assistantStreaming?: boolean;
  /** Controls whether persisted-message actions are interactive for assistant output. */
  assistantActionsVisible?: boolean;
}

/** Single image thumbnail with error fallback and optional full-size preview. */
function ImageThumbnail({
  src,
  name,
  single,
  onOpenPreview,
}: {
  src: string;
  name: string;
  single: boolean;
  onOpenPreview?: () => void;
}) {
  const image = useRetriableAttachmentImage(src);

  const frame = cn(
    "relative overflow-hidden rounded-xl bg-muted/40 ring-1 ring-border/40",
    single ? "max-w-[240px]" : "max-w-[140px]",
  );

  if (image.failed) {
    return (
      <div className={frame}>
        <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2.5">
          <ImageIcon size={14} className="shrink-0 text-muted-foreground" />
          <span className="truncate text-xs text-muted-foreground">{name}</span>
        </div>
      </div>
    );
  }

  const imgEl = (
    <>
      <img
        src={image.src}
        alt={name}
        className={cn(
          "block h-auto max-h-[160px] w-full object-contain transition-opacity",
          image.retrying ? "min-h-16 min-w-24 opacity-0" : "opacity-100",
        )}
        loading="lazy"
        onError={image.onError}
        onLoad={image.onLoad}
        style={{ imageOrientation: "from-image" }}
      />
      {image.retrying ? (
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground/70">
          <ImageIcon size={14} className="animate-pulse" aria-hidden />
        </span>
      ) : null}
    </>
  );

  if (onOpenPreview) {
    return (
      <button
        type="button"
        className={cn(
          frame,
          "block w-full cursor-pointer bg-transparent p-0 text-left outline-none",
          "transition-[box-shadow,filter] hover:brightness-[1.03] hover:ring-border/65",
          "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
        aria-label={`Preview image ${name}`}
        onClick={onOpenPreview}
      >
        {imgEl}
      </button>
    );
  }

  return <div className={frame}>{imgEl}</div>;
}

/** Copy button with check feedback, visible on parent hover. */
function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write failed — don't show copied state
    }
  }, [content]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/60 text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover/msg:opacity-100"
      aria-label="Copy message"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

/** Branch button visible on hover, matching CopyButton style. */
function BranchButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/60 text-muted-foreground opacity-0 scale-90 transition-all duration-150 hover:bg-primary/10 hover:text-primary group-hover/msg:opacity-100 group-hover/msg:scale-100"
            aria-label="Fork from this message"
          >
            <GitFork size={14} />
          </button>
        }
      />
      <TooltipContent side="top" className="text-xs">Fork from here</TooltipContent>
    </Tooltip>
  );
}

/** Reply button visible on hover, matching BranchButton style. */
function ReplyButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/60 text-muted-foreground opacity-0 scale-90 transition-all duration-150 hover:bg-primary/10 hover:text-primary group-hover/msg:opacity-100 group-hover/msg:scale-100"
            aria-label="Reply to this message"
          >
            <Reply size={14} className="scale-x-[-1]" />
          </button>
        }
      />
      <TooltipContent side="top" className="text-xs">Reply</TooltipContent>
    </Tooltip>
  );
}

/**
 * Quoted message preview rendered above the bubble content when
 * `reply_to_message_id` is set on the message.
 */
function QuoteBlock({
  quotedText,
  available = true,
  onClick,
}: {
  quotedText: string;
  available?: boolean;
  onClick?: () => void;
}) {
  if (!available) {
    return (
      <div className="mb-1.5 rounded-md border-l-2 border-muted-foreground/20 bg-muted/20 px-2.5 py-1.5 select-none">
        <p className="text-xs text-muted-foreground/40 italic">Original message unavailable</p>
      </div>
    );
  }

  const label = "Reply";
  const displayText = quotedText.slice(0, 150) + (quotedText.length > 150 ? "..." : "");

  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-1.5 w-full cursor-pointer rounded-md border-l-2 border-primary/40 bg-muted/30 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/50 select-none"
    >
      <p className="text-xs font-semibold text-primary/60 leading-none mb-0.5">{label}</p>
      <p className="text-xs text-muted-foreground/60 truncate italic">{displayText}</p>
    </button>
  );
}

/** Renders a single chat message (system, user, or assistant). Memoized to prevent re-renders when the message ref is unchanged. */
export const MessageBubble = memo(function MessageBubble({
  message,
  interactive = true,
  onBranch,
  onReply,
  onScrollToMessage,
  assistantStreaming,
  assistantActionsVisible = true,
}: MessageBubbleProps) {
  const [imagePreview, setImagePreview] = useState<{
    items: { src: string; title: string }[];
    initialIndex: number;
  } | null>(null);

  const formattedTime = useMemo(
    () => new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    [message.timestamp],
  );

  const threadProvider = useWorkspaceStore((s) =>
    s.threads.find((t) => t.id === message.thread_id)?.provider,
  );
  const providerCatalog = useProviderModelsStore((s) =>
    threadProvider ? s.models[threadProvider] : undefined,
  );
  const modelDisplayLabel = useMemo(
    () =>
      message.model
        ? resolveModelDisplayLabel(message.model, { catalog: providerCatalog })
        : null,
    [message.model, providerCatalog],
  );

  const imageAttachments = useMemo(
    () => message.attachments?.filter((a) => a.mimeType.startsWith("image/")) ?? [],
    [message.attachments],
  );
  const fileAttachments = useMemo(
    () => message.attachments?.filter((a) => !a.mimeType.startsWith("image/")) ?? [],
    [message.attachments],
  );
  const textContent = useMemo(() => stripInjectedFiles(message.content), [message.content]);
  const hasPreviewAnnotations =
    (message.previewAnnotations?.annotations.length ?? 0) > 0;

  const isAnsweredPlanMessage = useThreadRecord(
    message.thread_id,
    (r) => r.answeredPlanMessageIds.has(message.id),
  );

  const imageSlides = useMemo(
    () =>
      imageAttachments.map((img) => ({
        src: buildStoredAttachmentImageSrc(message.thread_id, img.id, img.mimeType),
        title: img.name,
      })),
    [imageAttachments, message.thread_id],
  );

  if (message.role === "system") {
    if (isHandoffMessage(message.role, message.content)) {
      if (parseHandoffJson(message.content)) {
        return <HandoffCard content={message.content} />;
      }
      // Malformed handoff JSON: fall through to normal system-message rendering.
    }

    const agentError = parseAgentError(message.content);
    if (agentError) {
      return (
        <div className="flex items-start gap-2.5 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-destructive/60" />
          <p className="text-muted-foreground leading-relaxed">{agentError}</p>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-3 py-2" role="note">
        <div className="h-px flex-1 bg-border" aria-hidden="true" />
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RotateCcw size={12} aria-hidden="true" />
          <span>{message.content}</span>
        </div>
        <div className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
    );
  }

  // Goal-status confirmations are emitted by AgentService when the user types
  // /goal in the composer. They arrive as assistant messages but read as
  // chat-control notices, not model output — render them as a compact pill
  // rather than a full bubble.
  if (message.role === "assistant") {
    const goal = parseGoalStatusNotice(textContent);
    if (goal) {
      // "Goal achieved" is the agent-side payoff — give it the same legible
      // receipt vocabulary as the user's "Sent as goal" marker rather than a
      // faint hairline, so the moment the goal lands is easy to spot. The
      // remaining control acknowledgements stay quiet hairline chapter-breaks.
      if (goal.label === "Goal achieved") {
        return (
          <div className="flex py-1.5" role="note" aria-label={goal.hint ? `Goal achieved in ${goal.hint}` : "Goal achieved"}>
            <GoalReceipt label="Goal achieved" suffix={goal.hint ? `in ${goal.hint}` : undefined} />
          </div>
        );
      }
      return <GoalPill label={goal.label} condition={goal.condition} hint={goal.hint} />;
    }
  }

  // User-typed `/goal <condition>` SET form. AgentService rewrites only the
  // provider-facing payload; the transcript keeps a normal user bubble with
  // the command token stripped and a quiet "Sent as goal" footer.
  const userGoal = message.role === "user" ? parseUserGoalCommand(textContent) : null;
  const hasAttachments = imageAttachments.length > 0 || fileAttachments.length > 0;

  // Suppress the plan-mode answer payload that the server sends to the model
  // on submit — the AnsweredSummary marker on the originating assistant
  // message is the canonical UI representation for the answered batch, so
  // also rendering the verbose user re-statement would be redundant noise
  // when the thread reloads.
  if (
    message.role === "user" &&
    !hasAttachments &&
    !hasPreviewAnnotations &&
    textContent.startsWith(PLAN_ANSWER_MESSAGE_PREFIX)
  ) {
    return null;
  }
  const isUser = message.role === "user";
  const userDisplayText = userGoal ? userGoal.condition : textContent;
  const parentAgentProvenance = message.parentAgentProvenance;
  const parentAgentDetails = parentAgentProvenance
    ? [
        `Thread ${parentAgentProvenance.parentThreadId}`,
        `Turn ${parentAgentProvenance.parentTurnId}`,
        `Item ${parentAgentProvenance.parentItemId}`,
        ...parentAgentProvenance.providerIdentities.map((identity) =>
          `${identity.providerId} ${identity.scope}: ${identity.value} (${identity.provenance})`,
        ),
      ].join(" · ")
    : "";

  if (isUser) {

    return (
      <>
        <div className="group/msg flex justify-end" data-message-id={message.id} data-message-role={message.role} data-thread-id={message.thread_id}>
          <div className="min-w-0 max-w-[min(82%,56rem)] space-y-1.5">
            {/* Quote block — shown when this message is a reply */}
            {message.reply_to_message_id && (
              <QuoteBlock
                quotedText={message.quoted_text ?? ""}
                available={!!message.quoted_text}
                onClick={() => onScrollToMessage?.(message.reply_to_message_id!)}
              />
            )}
            {/* Image attachments — standalone thumbnails above the bubble */}
            {imageAttachments.length > 0 && (
              <div className={cn(
                "flex justify-end gap-1.5",
                imageAttachments.length > 2 ? "flex-wrap" : ""
              )}>
                {imageAttachments.map((img, idx) => {
                  const src = buildStoredAttachmentImageSrc(message.thread_id, img.id, img.mimeType);
                  return (
                    <ImageThumbnail
                      key={img.id}
                      src={src}
                      name={img.name}
                      single={imageAttachments.length === 1}
                      onOpenPreview={interactive
                        ? () => setImagePreview({ items: imageSlides, initialIndex: idx })
                        : undefined}
                    />
                  );
                })}
              </div>
            )}

            {/* Non-image files sit outside the colored bubble so names stay readable on any theme. */}
            {fileAttachments.length > 0 && (
              <div className="flex flex-wrap justify-end gap-2">
                {fileAttachments.map((file) => (
                  <FileAttachmentTile
                    key={file.id}
                    variant="transcript"
                    name={file.name}
                    sizeBytes={file.sizeBytes}
                    mimeType={file.mimeType}
                  />
                ))}
              </div>
            )}

            {message.previewAnnotations ? (
              <div className="flex justify-end">
                <PreviewAnnotationBundleChip
                  bundle={message.previewAnnotations}
                  threadId={message.thread_id}
                  testId="sent-preview-annotation-bundle-chip"
                />
              </div>
            ) : null}

            {parentAgentProvenance ? (
              <div
                className="flex justify-end"
                role="note"
                aria-label={`Parent agent provenance: ${parentAgentDetails}`}
                data-testid="parent-agent-provenance"
              >
                <span className="font-mono text-xs text-muted-foreground/70" title={parentAgentDetails}>
                  Parent agent
                </span>
              </div>
            ) : null}

          {userDisplayText.trim() && (
            <div className="overflow-hidden break-words rounded-lg rounded-br-md bg-accent px-3 py-1.5 text-sm text-accent-foreground">
              {!userGoal && message.mentions?.length ? (
                <MentionedUserText text={userDisplayText} mentions={message.mentions} />
              ) : (
                <Suspense fallback={null}>
                  <LazyMarkdownContent content={userDisplayText} isStreaming={false} variant="user" />
                </Suspense>
              )}
            </div>
          )}

          <div className="flex flex-col items-end gap-0.5 pr-1">
            <div className="flex items-center gap-1.5">
              {interactive && onReply && <ReplyButton onClick={() => {
                let fallback = "[Attachment]";
                if (!userDisplayText.trim()) {
                  const firstAtt = message.attachments?.[0];
                  if (hasPreviewAnnotations && message.previewAnnotations) {
                    fallback = composerFeedbackReplyFallback(message.previewAnnotations);
                  } else if (firstAtt?.mimeType.startsWith("image/")) fallback = "[Image attachment]";
                  else if (firstAtt?.mimeType === "application/pdf") fallback = "[PDF attachment]";
                  else if (firstAtt) fallback = "[File attachment]";
                }
                onReply(message.id, userDisplayText.trim() || fallback, "user");
              }} />}
              {interactive && onBranch && <BranchButton onClick={() => onBranch(message.id)} />}
              {interactive && userDisplayText.trim() && <CopyButton content={userDisplayText} />}
            </div>
            <div className="flex items-center gap-2 font-mono text-xs tabular-nums text-muted-foreground/55">
              {userGoal && <GoalReceipt label="Sent as goal" tone="muted" />}
              <span>{formattedTime}</span>
            </div>
          </div>
        </div>
        </div>
        <ImageAttachmentLightbox
          open={imagePreview !== null}
          onOpenChange={(open) => {
            if (!open) setImagePreview(null);
          }}
          items={imagePreview?.items ?? []}
          initialIndex={imagePreview?.initialIndex ?? 0}
        />
      </>
    );
  }

  // Assistant body that collapses to nothing visible (e.g. cursor-agent's
  // plan-mode output is exclusively a `plan-questions` fenced block, which
  // the markdown renderer suppresses).
  const assistantContentEmpty = isAssistantContentEmpty(message.content);
  if (assistantContentEmpty && !hasAttachments) {
    // For answered plan-questions messages, show a read-only summary
    // instead of hiding the bubble entirely (AC-1.28).
    if (isAnsweredPlanMessage) {
      return <AnsweredSummary content={message.content} messageId={message.id} />;
    }
    // Active wizard or unanswered: the wizard component handles rendering.
    return null;
  }

  // Assistant message — borderless prose flowing directly on the page.
  // The legacy `▸ ASSISTANT` head was removed because it pre-empted the prose
  // with redundant role labelling (only one party in the chat besides the
  // user). Provenance — model, tokens, cost, time — now lives in one quiet
  // foot line so the body owns the top of the message.
  const renderAssistantDelta = assistantStreaming !== undefined;
  const assistantActionsClass = cn(
    "flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 px-1 transition-opacity duration-150",
    assistantActionsVisible ? "opacity-100" : "pointer-events-none opacity-0",
  );
  const assistantReplyContent =
    textContent.trim() ||
    (imageAttachments.length > 0 ? "[Generated image]" : "[Assistant message]");

  return (
    <div className="group/msg space-y-2" data-message-id={message.id} data-message-role={message.role} data-thread-id={message.thread_id}>
      {/* Quote block — shown when this message is a reply */}
      {message.reply_to_message_id && (
        <QuoteBlock
          quotedText={message.quoted_text ?? ""}
          available={!!message.quoted_text}
          onClick={() => onScrollToMessage?.(message.reply_to_message_id!)}
        />
      )}
      {imageAttachments.length > 0 && (
        <div
          className={cn(
            "flex justify-start gap-1.5",
            imageAttachments.length > 2 ? "flex-wrap" : "",
          )}
          data-testid="assistant-image-attachments"
        >
          {imageAttachments.map((img, idx) => {
            const src = buildStoredAttachmentImageSrc(message.thread_id, img.id, img.mimeType);
            return (
              <ImageThumbnail
                key={img.id}
                src={src}
                name={img.name}
                single={imageAttachments.length === 1}
                onOpenPreview={() =>
                  setImagePreview({ items: imageSlides, initialIndex: idx })
                }
              />
            );
          })}
        </div>
      )}
      {fileAttachments.length > 0 && (
        <div className="flex flex-wrap justify-start gap-2">
          {fileAttachments.map((file) => (
            <FileAttachmentTile
              key={file.id}
              variant="transcript"
              name={file.name}
              sizeBytes={file.sizeBytes}
              mimeType={file.mimeType}
            />
          ))}
        </div>
      )}
      {!assistantContentEmpty && (
        <div className="text-sm text-foreground" data-testid="assistant-response-text">
          {renderAssistantDelta ? (
            <DeltaBlock
              text={message.content}
              isStreaming={assistantStreaming}
              showCursor={assistantStreaming}
            />
          ) : (
            <Suspense fallback={null}>
              <LazyMarkdownContent content={message.content} isStreaming={false} threadId={message.thread_id} chatHighlighting />
            </Suspense>
          )}
        </div>
      )}
      <div
        className={assistantActionsClass}
        data-testid="assistant-message-actions"
        aria-hidden={assistantActionsVisible ? undefined : true}
      >
        {assistantActionsVisible && onReply && <ReplyButton onClick={() => onReply(message.id, assistantReplyContent, "assistant")} />}
        {assistantActionsVisible && onBranch && <BranchButton onClick={() => onBranch(message.id)} />}
        {assistantActionsVisible && textContent.trim() && <CopyButton content={textContent} />}
        {assistantActionsVisible && (message.model || message.tokens_used != null || message.cost_usd != null || formattedTime) && (
          <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground/55 transition-colors group-hover/msg:text-muted-foreground/80">
            {[
              modelDisplayLabel,
              message.tokens_used != null ? `${message.tokens_used.toLocaleString()} tok` : null,
              message.cost_usd != null ? `$${message.cost_usd.toFixed(4)}` : null,
              formattedTime,
            ].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
      <ImageAttachmentLightbox
        open={imagePreview !== null}
        onOpenChange={(open) => {
          if (!open) setImagePreview(null);
        }}
        items={imagePreview?.items ?? []}
        initialIndex={imagePreview?.initialIndex ?? 0}
      />
    </div>
  );
});
