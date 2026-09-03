import { memo, useMemo, useState, useCallback, useRef, useEffect, useSyncExternalStore, lazy, Suspense, type ReactNode } from "react";
import type { Message } from "@/transport";
import { ImageIcon, RotateCcw, Copy, Check, GitFork, AlertCircle, Target } from "lucide-react";
import { cn } from "@/lib/utils";
const LazyMarkdownContent = lazy(() => import("@/components/chat/MarkdownContent"));
import { stripInjectedFiles } from "@/lib/file-tags";
import {
  buildStoredAttachmentImageSrc,
  getAttachmentTransportUrlSnapshot,
  subscribeToAttachmentTransportUrl,
} from "@/lib/attachment-url";
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
import { PreviewAnnotationBundleChip } from "@/components/chat/PreviewAnnotationBundleChip";
import { useRetriableAttachmentImage } from "@/components/chat/useRetriableAttachmentImage";
import { EntityToken } from "@/components/chat/EntityToken";
import { basename } from "@/lib/path";
import { SelectedTextCommentsComposerAttachment } from "../composer/SelectedTextCommentsComposerAttachment";

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
    const rawMention = getRawMention(mention);
    if (!isVisibleMention(text, cursor, mention.range, rawMention)) continue;
    addLeadingText(nodes, text, cursor, mention.range.start);
    nodes.push(createMentionToken(mention, rawMention));
    cursor = mention.range.end;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <p className="mb-2 whitespace-pre-wrap leading-relaxed">{nodes}</p>;
}

/** Gets the unmodified transcript text for a mention. */
function getRawMention(mention: NonNullable<Message["mentions"]>[number]): string {
  return mention.kind === "command" ? `/${mention.label}` : `@${mention.label}`;
}

/** Checks that a mention range still points at the user-entered mention text. */
function isVisibleMention(
  text: string,
  cursor: number,
  range: { start: number; end: number },
  rawMention: string,
): boolean {
  return range.start >= cursor
    && range.end <= text.length
    && text.slice(range.start, range.end) === rawMention;
}

/** Appends text that appears before the next mention token. */
function addLeadingText(nodes: ReactNode[], text: string, cursor: number, mentionStart: number): void {
  if (mentionStart > cursor) nodes.push(text.slice(cursor, mentionStart));
}

/** Creates the user-tone entity token for one valid mention. */
function createMentionToken(mention: NonNullable<Message["mentions"]>[number], rawMention: string): ReactNode {
  const label = mention.kind === "file" ? `@${basename(mention.path)}` : rawMention;
  return (
    <EntityToken
      key={`${mention.id}-${mention.range.start}`}
      kind={mention.kind === "command" ? mention.namespace : mention.kind}
      label={label}
      filePath={mention.kind === "file" ? mention.path : undefined}
      title={rawMention}
      tone="user"
      invocation={mention.kind === "command"}
    />
  );
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
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  aria-expanded="false"
                  aria-label="Expand full goal condition"
                  dir="auto"
                  className="min-w-0 cursor-pointer truncate text-left font-serif text-sm italic leading-snug text-foreground hover:text-foreground/80"
                >
                  &ldquo;{condition}&rdquo;
                </button>
              }
            />
            <TooltipContent>{condition}</TooltipContent>
          </Tooltip>
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
import type { AgentDisplayState } from "./virtual-items";

const COMPLETED_AGENT_DISPLAY_STATE: AgentDisplayState = { phase: "completed" };

/** Props for {@link MessageBubble}. */
interface MessageBubbleProps {
  /** The message object to render. */
  message: Message;
  /** Controls whether user-message actions such as copy or fork are available. */
  interactive?: boolean;
  /** Called when the user clicks the branch icon on this message. */
  onBranch?: (messageId: string) => void;
  /** Called when the user clicks a quote block to scroll to the original message. */
  onScrollToMessage?: (messageId: string) => void;
  /** Lifecycle state that controls the visible treatment of this agent response. */
  agentDisplayState?: AgentDisplayState;
  /** Whether a child prompt displays its parent-agent provenance label. */
  showParentAgentProvenance?: boolean;
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

type Attachment = NonNullable<Message["attachments"]>[number];

const IMAGE_ATTACHMENT_ALIGNMENT_CLASS = {
  start: "flex justify-start gap-1.5",
  end: "flex justify-end gap-1.5",
} as const;

const FILE_ATTACHMENT_ALIGNMENT_CLASS = {
  start: "flex flex-wrap justify-start gap-2",
  end: "flex flex-wrap justify-end gap-2",
} as const;

/** Separates a message's image and file attachments and derives its preview slides. */
function useMessageAttachments(message: Message) {
  const attachmentTransportUrl = useSyncExternalStore(
    subscribeToAttachmentTransportUrl,
    getAttachmentTransportUrlSnapshot,
    getAttachmentTransportUrlSnapshot,
  );
  const imageAttachments = useMemo(
    () => message.attachments?.filter((attachment) => attachment.mimeType.startsWith("image/")) ?? [],
    [message.attachments],
  );
  const fileAttachments = useMemo(
    () => message.attachments?.filter((attachment) => !attachment.mimeType.startsWith("image/")) ?? [],
    [message.attachments],
  );
  const imageSlides = useMemo(
    () => {
      void attachmentTransportUrl;
      return imageAttachments.map((image) => ({
        src: buildStoredAttachmentImageSrc(message.thread_id, image.id, image.mimeType),
        title: image.name,
      }));
    },
    [attachmentTransportUrl, imageAttachments, message.thread_id],
  );
  return { imageAttachments, fileAttachments, imageSlides };
}

/** Renders the image attachment strip for a transcript message. */
function MessageImageAttachments({
  message,
  images,
  align,
  testId,
  interactive = true,
  onOpenPreview,
}: {
  message: Message;
  images: Attachment[];
  align: "start" | "end";
  testId?: string;
  interactive?: boolean;
  onOpenPreview: (index: number) => void;
}) {
  if (images.length === 0) return null;
  const className = cn(
    IMAGE_ATTACHMENT_ALIGNMENT_CLASS[align],
    images.length > 2 ? "flex-wrap" : "",
  );
  return (
    <div className={className} data-testid={testId}>
      {images.map((image, index) => (
        <ImageThumbnail
          key={image.id}
          src={buildStoredAttachmentImageSrc(message.thread_id, image.id, image.mimeType)}
          name={image.name}
          single={images.length === 1}
          onOpenPreview={interactive ? () => onOpenPreview(index) : undefined}
        />
      ))}
    </div>
  );
}

/** Renders non-image attachments outside a message bubble. */
function MessageFileAttachments({ files, align }: { files: Attachment[]; align: "start" | "end" }) {
  if (files.length === 0) return null;
  return (
    <div className={FILE_ATTACHMENT_ALIGNMENT_CLASS[align]}>
      {files.map((file) => (
        <FileAttachmentTile
          key={file.id}
          variant="transcript"
          name={file.name}
          sizeBytes={file.sizeBytes}
          mimeType={file.mimeType}
        />
      ))}
    </div>
  );
}

/** Closes the message image lightbox without clearing an open preview. */
function MessageImageLightbox({
  imagePreviewIndex,
  imageSlides,
  onClose,
}: {
  imagePreviewIndex: number | null;
  imageSlides: { src: string; title: string }[];
  onClose: () => void;
}) {
  return (
    <ImageAttachmentLightbox
      open={imagePreviewIndex !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      items={imageSlides}
      initialIndex={imagePreviewIndex ?? 0}
    />
  );
}

/** Renders actions and the timestamp for a user message. */
function UserMessageFooter({
  message,
  displayText,
  formattedTime,
  interactive,
  onBranch,
  userGoal,
}: {
  message: Message;
  displayText: string;
  formattedTime: string;
  interactive: boolean;
  onBranch?: (messageId: string) => void;
  userGoal: { condition: string } | null;
}) {
  return (
    <div className="flex flex-col items-end gap-0.5 pr-1">
      <UserMessageActions
        message={message}
        displayText={displayText}
        interactive={interactive}
        onBranch={onBranch}
      />
      <div className="flex items-center gap-2 font-mono text-xs tabular-nums text-muted-foreground/55">
        {userGoal && <GoalReceipt label="Sent as goal" tone="muted" />}
        <span>{formattedTime}</span>
      </div>
    </div>
  );
}

/** Renders the text content inside a user message bubble. */
function UserMessageText({ message, displayText, userGoal }: { message: Message; displayText: string; userGoal: { condition: string } | null }) {
  if (!displayText.trim()) return null;
  const hasMentions = !userGoal && Boolean(message.mentions?.length);
  return (
    <div
      className="overflow-hidden break-words rounded-lg rounded-br-md bg-accent px-3 py-1.5 text-sm text-accent-foreground"
      data-selected-text-content
      data-selected-text-eligible="true"
    >
      {hasMentions ? (
        <MentionedUserText text={displayText} mentions={message.mentions!} />
      ) : (
        <Suspense fallback={null}>
          <LazyMarkdownContent content={displayText} isStreaming={false} variant="user" />
        </Suspense>
      )}
    </div>
  );
}

/** Renders the quoted source above a user message. */
function UserMessageQuote({
  message,
  onScrollToMessage,
}: {
  message: Message;
  onScrollToMessage?: (messageId: string) => void;
}) {
  if (!message.reply_to_message_id) return null;
  return (
    <QuoteBlock
      quotedText={message.quoted_text ?? ""}
      available={!!message.quoted_text}
      onClick={() => onScrollToMessage?.(message.reply_to_message_id!)}
    />
  );
}

/** Renders preview annotation feedback and parent-agent provenance. */
function UserMessageFeedback({
  message,
  showParentAgentProvenance,
  provenanceDetails,
}: {
  message: Message;
  showParentAgentProvenance: boolean;
  provenanceDetails: string;
}) {
  const provenance = message.parentAgentProvenance;
  return (
    <>
      {message.previewAnnotations && (
        <div className="flex justify-end">
          <PreviewAnnotationBundleChip bundle={message.previewAnnotations} threadId={message.thread_id} testId="sent-preview-annotation-bundle-chip" />
        </div>
      )}
      {showParentAgentProvenance && provenance && (
        <div className="flex justify-end" role="note" aria-label={`Parent agent provenance: ${provenanceDetails}`} data-testid="parent-agent-provenance">
          <Tooltip>
            <TooltipTrigger
              render={<span className="font-mono text-xs text-muted-foreground/70">Parent agent</span>}
            />
            <TooltipContent>{provenanceDetails}</TooltipContent>
          </Tooltip>
        </div>
      )}
    </>
  );
}

/** Renders persisted selected-text comments above a user message. */
function UserMessageComments({ message }: { message: Message }) {
  if (!message.selectedTextComments?.length) return null;

  return (
    <SelectedTextCommentsComposerAttachment
      comments={message.selectedTextComments}
      readOnly
      onRemove={ignoreSelectedTextComment}
      onOpenSource={ignoreSelectedTextComment}
      onEdit={ignoreSelectedTextComment}
      onDelete={ignoreSelectedTextComment}
      onFocusComposer={ignoreSelectedTextComment}
      onSave={ignoreSelectedTextComment}
      onEditorChange={ignoreSelectedTextComment}
    />
  );
}

function ignoreSelectedTextComment(): void {}

/** Renders the user message action controls. */
function UserMessageActions({
  message,
  displayText,
  interactive,
  onBranch,
}: {
  message: Message;
  displayText: string;
  interactive: boolean;
  onBranch?: (messageId: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {interactive && onBranch && <BranchButton onClick={() => onBranch(message.id)} />}
      {interactive && displayText.trim() && <CopyButton content={displayText} />}
    </div>
  );
}

/** Renders a user message, including attachments and composer feedback. */
function UserMessageContent({
  message,
  interactive,
  onBranch,
  onScrollToMessage,
  showParentAgentProvenance,
}: MessageBubbleProps & { interactive: boolean; showParentAgentProvenance: boolean }) {
  const [imagePreviewIndex, setImagePreviewIndex] = useState<number | null>(null);
  const { imageAttachments, fileAttachments, imageSlides } = useMessageAttachments(message);
  const textContent = useMemo(() => stripInjectedFiles(message.content), [message.content]);
  const userGoal = parseUserGoalCommand(textContent);
  const hasPreviewAnnotations = (message.previewAnnotations?.annotations.length ?? 0) > 0;
  const hasAttachments = imageAttachments.length > 0 || fileAttachments.length > 0;
  const formattedTime = useMemo(
    () => new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    [message.timestamp],
  );
  if (!hasAttachments && !hasPreviewAnnotations && textContent.startsWith(PLAN_ANSWER_MESSAGE_PREFIX)) return null;
  const displayText = userGoal ? userGoal.condition : textContent;
  const provenance = message.parentAgentProvenance;
  const provenanceDetails = provenance ? [
    `Thread ${provenance.parentThreadId}`,
    `Turn ${provenance.parentTurnId}`,
    `Item ${provenance.parentItemId}`,
    ...provenance.providerIdentities.map((identity) =>
      `${identity.providerId} ${identity.scope}: ${identity.value} (${identity.provenance})`,
    ),
  ].join(" · ") : "";
  return (
    <>
      <div className="group/msg flex justify-end" data-message-id={message.id} data-message-role={message.role} data-thread-id={message.thread_id}>
        <div className="min-w-0 max-w-[min(82%,56rem)] space-y-1.5">
          <UserMessageQuote message={message} onScrollToMessage={onScrollToMessage} />
          <MessageImageAttachments message={message} images={imageAttachments} align="end" interactive={interactive} onOpenPreview={setImagePreviewIndex} />
          <MessageFileAttachments files={fileAttachments} align="end" />
          <UserMessageFeedback message={message} showParentAgentProvenance={showParentAgentProvenance} provenanceDetails={provenanceDetails} />
          <UserMessageComments message={message} />
          <UserMessageText message={message} displayText={displayText} userGoal={userGoal} />
          <UserMessageFooter
            message={message}
            displayText={displayText}
            formattedTime={formattedTime}
            interactive={interactive}
            onBranch={onBranch}
            userGoal={userGoal}
          />
        </div>
      </div>
      <MessageImageLightbox imagePreviewIndex={imagePreviewIndex} imageSlides={imageSlides} onClose={() => setImagePreviewIndex(null)} />
    </>
  );
}

/** Renders a system message, including structured handoffs and synthetic agent errors. */
function SystemMessageContent({ message }: Pick<MessageBubbleProps, "message">) {
  if (isHandoffMessage(message.role, message.content) && parseHandoffJson(message.content)) {
    return <HandoffCard content={message.content} />;
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

/** Renders assistant goal control notices outside the normal assistant response. */
function AssistantGoalNotice({ goal }: { goal: NonNullable<ReturnType<typeof parseGoalStatusNotice>> }) {
  if (!goal) return null;
  if (goal.label === "Goal achieved") {
    return (
      <div className="flex py-1.5" role="note" aria-label={goal.hint ? `Goal achieved in ${goal.hint}` : "Goal achieved"}>
        <GoalReceipt label="Goal achieved" suffix={goal.hint ? `in ${goal.hint}` : undefined} />
      </div>
    );
  }
  return <GoalPill label={goal.label} condition={goal.condition} hint={goal.hint} />;
}

/** Renders the assistant response text without metadata or action controls. */
function AssistantResponseText({
  message,
  assistantContentEmpty,
  agentDisplayState,
  isAgentResponseComplete,
}: {
  message: Message;
  assistantContentEmpty: boolean;
  agentDisplayState?: AgentDisplayState;
  isAgentResponseComplete: boolean;
}) {
  if (assistantContentEmpty) return null;
  const isStreaming = agentDisplayState?.phase === "streaming";
  const renderDelta = isStreaming || agentDisplayState?.phase === "finalizing";
  return (
    <div className="text-sm text-foreground" data-testid="assistant-response-text" data-selected-text-content data-selected-text-eligible={isAgentResponseComplete ? "true" : "false"}>
      {renderDelta ? (
        <DeltaBlock text={message.content} isStreaming={isStreaming} showCursor={isStreaming} />
      ) : (
        <Suspense fallback={null}>
          <LazyMarkdownContent content={message.content} isStreaming={false} threadId={message.thread_id} chatHighlighting />
        </Suspense>
      )}
    </div>
  );
}

/** Resolves the catalog display label for an assistant message model. */
function useAssistantModelDisplayLabel(message: Message): string | null {
  const threadProvider = useWorkspaceStore((state) =>
    state.threads.find((thread) => thread.id === message.thread_id)?.provider,
  );
  const providerCatalog = useProviderModelsStore((state) => threadProvider ? state.models[threadProvider] : undefined);
  return useMemo(
    () => message.model ? resolveModelDisplayLabel(message.model, { catalog: providerCatalog }) : null,
    [message.model, providerCatalog],
  );
}

/** Renders completed assistant message controls and provenance metadata. */
function AssistantMessageFooter({
  message,
  textContent,
  formattedTime,
  modelDisplayLabel,
  isAgentResponseComplete,
  onBranch,
}: {
  message: Message;
  textContent: string;
  formattedTime: string;
  modelDisplayLabel: string | null;
  isAgentResponseComplete: boolean;
  onBranch?: (messageId: string) => void;
}) {
  if (!isAgentResponseComplete) return null;
  return (
    <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 px-1">
      <AssistantMessageActions message={message} textContent={textContent} onBranch={onBranch} />
      <AssistantMessageMetadata message={message} modelDisplayLabel={modelDisplayLabel} formattedTime={formattedTime} />
    </div>
  );
}

/** Renders completed assistant fork and copy controls. */
function AssistantMessageActions({
  message,
  textContent,
  onBranch,
}: {
  message: Message;
  textContent: string;
  onBranch?: (messageId: string) => void;
}) {
  const hasActions = Boolean(onBranch || textContent.trim());
  if (!hasActions) return null;
  return (
    <div className="flex items-center gap-x-3 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100" data-testid="agent-message-actions">
      {onBranch && <BranchButton onClick={() => onBranch(message.id)} />}
      {textContent.trim() && <CopyButton content={textContent} />}
    </div>
  );
}

/** Renders the quiet model, usage, cost, and time metadata for an assistant message. */
function AssistantMessageMetadata({
  message,
  modelDisplayLabel,
  formattedTime,
}: {
  message: Message;
  modelDisplayLabel: string | null;
  formattedTime: string;
}) {
  const metadata = [
    modelDisplayLabel,
    message.tokens_used != null ? `${message.tokens_used.toLocaleString()} tok` : null,
    message.cost_usd != null ? `$${message.cost_usd.toFixed(4)}` : null,
    formattedTime,
  ].filter(Boolean).join(" · ");
  return <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground/55" data-testid="agent-message-metadata">{metadata}</span>;
}

/** Renders an assistant message, including its live response state. */
function AssistantMessageContent({
  message,
  onBranch,
  onScrollToMessage,
  agentDisplayState,
}: MessageBubbleProps) {
  const [imagePreviewIndex, setImagePreviewIndex] = useState<number | null>(null);
  const { imageAttachments, fileAttachments, imageSlides } = useMessageAttachments(message);
  const textContent = useMemo(() => stripInjectedFiles(message.content), [message.content]);
  const isAnsweredPlanMessage = useThreadRecord(message.thread_id, (record) => record.answeredPlanMessageIds.has(message.id));
  const modelDisplayLabel = useAssistantModelDisplayLabel(message);
  const formattedTime = useMemo(
    () => new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    [message.timestamp],
  );
  const goal = parseGoalStatusNotice(textContent);
  if (goal) return <AssistantGoalNotice goal={goal} />;
  const assistantContentEmpty = isAssistantContentEmpty(message.content);
  const hasAttachments = imageAttachments.length > 0 || fileAttachments.length > 0;
  if (assistantContentEmpty && !hasAttachments) return isAnsweredPlanMessage ? <AnsweredSummary content={message.content} messageId={message.id} /> : null;
  const resolvedAgentDisplayState = agentDisplayState ?? COMPLETED_AGENT_DISPLAY_STATE;
  const isAgentResponseComplete = resolvedAgentDisplayState.phase === "completed";
  return (
    <div className="group/msg space-y-2" data-message-id={message.id} data-message-role={message.role} data-thread-id={message.thread_id}>
      {message.reply_to_message_id && (
        <QuoteBlock
          quotedText={message.quoted_text ?? ""}
          available={!!message.quoted_text}
          onClick={() => onScrollToMessage?.(message.reply_to_message_id!)}
        />
      )}
      <MessageImageAttachments message={message} images={imageAttachments} align="start" testId="assistant-image-attachments" onOpenPreview={setImagePreviewIndex} />
      <MessageFileAttachments files={fileAttachments} align="start" />
      <AssistantResponseText
        message={message}
        assistantContentEmpty={assistantContentEmpty}
        agentDisplayState={agentDisplayState}
        isAgentResponseComplete={isAgentResponseComplete}
      />
      <AssistantMessageFooter
        message={message}
        textContent={textContent}
        formattedTime={formattedTime}
        modelDisplayLabel={modelDisplayLabel}
        isAgentResponseComplete={isAgentResponseComplete}
        onBranch={onBranch}
      />
      <MessageImageLightbox imagePreviewIndex={imagePreviewIndex} imageSlides={imageSlides} onClose={() => setImagePreviewIndex(null)} />
    </div>
  );
}

/** Routes a message to its role-specific presentation without changing its outer memo boundary. */
function MessageRoleContent({
  message,
  interactive = true,
  onBranch,
  onScrollToMessage,
  agentDisplayState,
  showParentAgentProvenance = true,
}: MessageBubbleProps) {
  if (message.role === "system") return <SystemMessageContent message={message} />;
  if (message.role === "user") {
    return <UserMessageContent message={message} interactive={interactive} onBranch={onBranch} onScrollToMessage={onScrollToMessage} agentDisplayState={agentDisplayState} showParentAgentProvenance={showParentAgentProvenance} />;
  }
  return <AssistantMessageContent message={message} interactive={interactive} onBranch={onBranch} onScrollToMessage={onScrollToMessage} agentDisplayState={agentDisplayState} showParentAgentProvenance={showParentAgentProvenance} />;
}

/** Renders a single chat message and preserves memoization across unchanged props. */
export const MessageBubble = memo(MessageRoleContent);
