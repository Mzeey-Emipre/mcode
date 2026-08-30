import { memo, type CSSProperties } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { GripVertical, Paperclip, Pencil, Play, Trash2, X, Zap } from "lucide-react";
import { useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import { providerSupportsSendNow } from "@/lib/model-registry";
import { stripPreviewAnnotationFence } from "@/features/preview/capture/preview-annotation-append";
import { cn } from "@/lib/utils";
import { PreviewAnnotationBundleChip } from "./PreviewAnnotationBundleChip";

const EMPTY_QUEUE: QueuedMessage[] = [];

interface ComposerQueueListProps {
  threadId: string;
  isAgentRunning: boolean;
  /** Active provider id for this thread; gates the "Send now" affordance. */
  provider?: string;
  /**
   * Promote a queued message past the current turn: stop the running agent
   * and immediately dispatch this message. Only invoked when
   * `providerSupportsSendNow(provider)` is true.
   */
  onSendNow?: (message: QueuedMessage) => void;
  /**
   * Move a queued message back into the live composer for editing.
   * The list does the queue-side pop (via the store); the parent restores
   * input, attachments, reply context, and per-turn settings.
   */
  onLoadIntoComposer: (message: QueuedMessage) => void;
  /**
   * Drain the next queued message (FIFO) when the agent is idle. Shown as
   * a "Continue" affordance in the header. We intentionally do not auto-drain
   * on agent end - the user may have stopped intentionally and would not
   * want the queue to fire on its own.
   */
  onResume: () => void;
  /**
   * True when the Composer currently holds a queued message pulled out for
   * editing. While editing, the Continue affordance is hidden - draining
   * another queued item in parallel would silently displace the edit in
   * the composer and confuse the user.
   */
  isEditing?: boolean;
  /** True when another composer surface must finish before queued sends resume. */
  isPaused?: boolean;
}

/**
 * Inline stack of queued messages rendered ABOVE the Composer textarea.
 *
 * Replaces the prior popover. Editing is delegated back to the full Composer
 * (Cursor-style) so users have the same Lexical editor, attachment pipeline,
 * and slash commands available - not a cramped sub-textarea.
 *
 * Each row supports drag-to-reorder (keyboard accessible via dnd-kit), remove,
 * a provider-gated "Send now" interrupt, and "Edit in composer" which pops
 * the message and hands it to `onLoadIntoComposer`.
 */
export function ComposerQueueList({
  threadId,
  isAgentRunning,
  provider,
  onSendNow,
  onLoadIntoComposer,
  onResume,
  isEditing = false,
  isPaused = false,
}: ComposerQueueListProps) {
  const queue = useQueueStore((s) => s.queues[threadId] ?? EMPTY_QUEUE);
  const removeFromQueue = useQueueStore((s) => s.removeFromQueue);
  const clearQueue = useQueueStore((s) => s.clearQueue);
  const moveMessage = useQueueStore((s) => s.moveMessage);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (queue.length === 0) return null;

  const canSendNow =
    !isPaused && isAgentRunning && providerSupportsSendNow(provider) && !!onSendNow;

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const newIndex = queue.findIndex((m) => m.id === over.id);
    if (newIndex === -1) return;
    moveMessage(threadId, String(active.id), newIndex);
  }

  return (
    <section
      aria-label="Queued messages"
      className="mb-2 overflow-hidden rounded-xl bg-muted/30 ring-1 ring-inset ring-border/40"
    >
      {/* Header strip: small-caps mono, quiet, dev-tool feel.
          Continue is primary (only when idle); Clear all is quiet on the side. */}
      <header className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
        <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground/70">
          Queued
        </span>
        <div className="flex items-center gap-1.5">
          {!isAgentRunning && !isEditing && !isPaused && (
            <button
              type="button"
              onClick={onResume}
              aria-label="Send next queued message"
              className="flex items-center gap-1 rounded-sm bg-primary/10 px-1.5 py-0.5 font-mono text-xs uppercase tracking-[0.16em] text-primary transition-colors hover:bg-primary/20"
            >
              <Play size={9} strokeWidth={1.75} />
              Continue
            </button>
          )}
          <button
            type="button"
            onClick={() => clearQueue(threadId)}
            aria-label="Clear all queued messages"
            className="flex items-center gap-1 rounded-sm px-1 py-0.5 font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground/50 transition-colors hover:bg-destructive/8 hover:text-destructive"
          >
            <Trash2 size={9} strokeWidth={1.75} />
            Clear all
          </button>
        </div>
      </header>

      {/* Wrap rows in their own DOM container so restrictToParentElement
          confines the drag overlay to the rows-only region. Without this
          wrapper, the rows' DOM parent is the outer <section> (which
          includes the header), and dragging a row up would push the ghost
          into the header strip. */}
      <div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={queue.map((m) => m.id)}
            strategy={verticalListSortingStrategy}
          >
            {queue.map((msg, i) => (
              <QueueRow
                key={msg.id}
                msg={msg}
                index={i}
                canSendNow={canSendNow}
                onSendNow={onSendNow ? () => onSendNow(msg) : undefined}
                onEdit={() => onLoadIntoComposer(msg)}
                onRemove={() => removeFromQueue(threadId, msg.id)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </section>
  );
}

interface QueueRowProps {
  msg: QueuedMessage;
  index: number;
  canSendNow: boolean;
  onSendNow?: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

/**
 * Single queued-message row. Memoized so unrelated rows don't re-render when
 * one row mutates (drag, remove, edit). The container width stays narrow
 * enough that re-renders are cheap, but the cap of 20 makes memoization
 * worthwhile to keep drag-frame work minimal.
 */
const QueueRow = memo(function QueueRow({
  msg,
  index,
  canSendNow,
  onSendNow,
  onEdit,
  onRemove,
}: QueueRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: msg.id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { opacity: 0.55, zIndex: 2 } : {}),
  };

  // useSortable adds role/tabIndex; we apply listeners to the grip only,
  // so clicking the row body never starts a drag.
  const { role, tabIndex, ...rowA11y } = attributes;
  void role;
  void tabIndex;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...rowA11y}
      className={cn(
        "group flex items-center gap-2 px-2 py-1.5 transition-colors",
        "border-t border-border/30 first:border-t-0",
        !isDragging && "hover:bg-accent/40",
        isDragging && "bg-accent",
      )}
    >
      <DragGrip listeners={listeners} />
      <QueueRowPreview msg={msg} onEdit={onEdit} />
      <QueueRowMetadata msg={msg} />
      <QueueRowActions
        index={index}
        canSendNow={canSendNow}
        onSendNow={onSendNow}
        onEdit={onEdit}
        onRemove={onRemove}
      />
    </div>
  );
});

/** The editable text preview for a queued Composer message. */
function QueueRowPreview({ msg, onEdit }: Pick<QueueRowProps, "msg" | "onEdit">) {
  const previewText = stripPreviewAnnotationFence(msg.displayContent || msg.content);
  const emptyMessageLabel = hasPreviewAnnotations(msg)
    ? "Preview annotation"
    : "Empty queued message";

  return (
    <button
      type="button"
      onClick={onEdit}
      aria-label={previewText ? undefined : "Edit queued annotation"}
      title="Edit in composer"
      className="min-w-0 flex-1 cursor-text text-left"
    >
      {previewText
        ? <span className="block truncate text-xs leading-snug text-foreground/90">{previewText}</span>
        : <span className="sr-only">{emptyMessageLabel}</span>}
    </button>
  );
}

/** Returns whether a queued message includes captured preview annotations. */
function hasPreviewAnnotations(msg: QueuedMessage): boolean {
  return (msg.previewAnnotations?.annotations.length ?? 0) > 0;
}

/** Displays a queued message's annotation and attachment metadata. */
function QueueRowMetadata({ msg }: Pick<QueueRowProps, "msg">) {
  return (
    <>
      {hasPreviewAnnotations(msg) && msg.previewAnnotations ? (
        <PreviewAnnotationBundleChip
          bundle={msg.previewAnnotations}
          testId="queue-annotation-bundle"
          className="shrink-0 rounded-md px-1.5 py-0.5 text-xs"
        />
      ) : null}
      <QueueAttachmentCount attachments={msg.attachments} />
    </>
  );
}

/** Displays the attachment count only when the queued message has attachments. */
function QueueAttachmentCount({ attachments }: Pick<QueuedMessage, "attachments">) {
  if (attachments.length === 0) return null;
  const attachmentLabel = attachments.length === 1 ? "attachment" : "attachments";

  return (
    <span
      className="flex shrink-0 items-center gap-0.5 font-mono text-xs tabular-nums text-muted-foreground/55"
      aria-label={`${attachments.length} ${attachmentLabel}`}
    >
      <Paperclip size={9} strokeWidth={1.75} />
      {attachments.length}
    </span>
  );
}

/** Hover-revealed actions for a queued Composer message. */
function QueueRowActions({
  index,
  canSendNow,
  onSendNow,
  onEdit,
  onRemove,
}: Omit<QueueRowProps, "msg">) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      {canSendNow && onSendNow ? <QueueSendNowAction index={index} onSendNow={onSendNow} /> : null}
      <RowAction label={`Edit queued message ${index + 1}`} hint="Edit in composer" tone="muted" onClick={onEdit}>
        <Pencil size={11} strokeWidth={1.75} />
      </RowAction>
      <RowAction label={`Remove queued message ${index + 1}`} hint="Remove" tone="destructive" onClick={onRemove}>
        <X size={11} strokeWidth={1.75} />
      </RowAction>
    </div>
  );
}

/** Sends a queued message before the active agent turn finishes. */
function QueueSendNowAction({ index, onSendNow }: Pick<QueueRowProps, "index" | "onSendNow">) {
  if (!onSendNow) return null;

  return (
    <RowAction label={`Send queued message ${index + 1} now`} hint="Send now (queued next)" tone="primary" onClick={onSendNow}>
      <Zap size={11} strokeWidth={1.75} />
    </RowAction>
  );
}

/** Grip glyph that activates dnd-kit drag and keyboard reorder. */
function DragGrip({ listeners }: { listeners: DraggableSyntheticListeners }) {
  return (
    <button
      type="button"
      aria-label="Reorder message (drag, or press space then arrow keys)"
      className="cursor-grab text-muted-foreground/25 transition-colors hover:text-muted-foreground/70 focus:text-muted-foreground/70 focus:outline-none active:cursor-grabbing"
      {...listeners}
    >
      <GripVertical size={11} strokeWidth={1.5} />
    </button>
  );
}

interface RowActionProps {
  label: string;
  hint: string;
  tone: "primary" | "muted" | "destructive";
  onClick: () => void;
  children: React.ReactNode;
}

/** Tiny icon-button used in the row's action cluster. */
function RowAction({ label, hint, tone, onClick, children }: RowActionProps) {
  const toneClass =
    tone === "primary"
      ? "hover:bg-primary/10 hover:text-primary"
      : tone === "destructive"
        ? "hover:bg-destructive/10 hover:text-destructive"
        : "hover:bg-muted hover:text-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={hint}
      className={cn(
        "rounded-sm p-1 text-muted-foreground/60 transition-colors",
        toneClass,
      )}
    >
      {children}
    </button>
  );
}
