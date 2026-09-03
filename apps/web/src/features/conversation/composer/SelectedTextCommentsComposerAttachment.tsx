import { useEffect, useRef, useState } from "react";
import { MessageCircle, Pencil, X } from "lucide-react";
import type { SelectedTextComment } from "@mcode/contracts";
import type { SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SelectedTextCommentEditor } from "../messages/selection/SelectedTextCommentEditor";

/** Props for the aggregate selected-text comment attachment in the composer. */
export interface SelectedTextCommentsComposerAttachmentProps {
  /** Saved comments attached to the active composer draft. */
  readonly comments: readonly SelectedTextComment[];
  /** Restored card-anchored editor state, if the source is unavailable. */
  readonly editor?: SelectedTextCommentEditorDraft;
  /** Comment IDs whose source failed to load or reconstruct. */
  readonly unavailableSourceCommentIds?: readonly string[];
  /** Removes every selected-text comment from the active draft. */
  readonly onRemove: () => void;
  /** Loads and opens one card's source. */
  readonly onOpenSource: (comment: SelectedTextComment) => void;
  /** Opens one card for editing. */
  readonly onEdit: (comment: SelectedTextComment) => void;
  /** Deletes one saved card. */
  readonly onDelete: (comment: SelectedTextComment) => void;
  /** Restores focus to the composer when deleting the final card. */
  readonly onFocusComposer: () => void;
  /** Saves a card-anchored editor. */
  readonly onSave: (comment: SelectedTextComment) => void;
  /** Persists a card-anchored editor change. */
  readonly onEditorChange: (editor: SelectedTextCommentEditorDraft | undefined) => void;
}

function annotationLabel(count: number): string {
  return `${count} annotation${count === 1 ? "" : "s"}`;
}

function QuotePreview({ quote }: { readonly quote: string }) {
  const quoteRef = useRef<HTMLParagraphElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const element = quoteRef.current;
    if (!element) return;
    const update = () => setOverflows(element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth);
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [quote]);

  return (
    <div className="min-w-0">
      <p
        ref={quoteRef}
        className={isExpanded
          ? "whitespace-pre-wrap break-words text-sm leading-5"
          : "line-clamp-3 overflow-hidden whitespace-pre-wrap break-words text-sm leading-5"}
      >
        {quote}
      </p>
      {!isExpanded && overflows && (
        <Button type="button" variant="link" size="sm" className="pointer-events-auto mt-0.5 h-auto px-0 text-xs" onClick={() => setIsExpanded(true)}>
          Show full quote
        </Button>
      )}
      {isExpanded && (
        <Button type="button" variant="link" size="sm" className="pointer-events-auto mt-0.5 h-auto px-0 text-xs" onClick={() => setIsExpanded(false)}>
          Collapse quote
        </Button>
      )}
    </div>
  );
}

function CommentPreviewItem({
  comment,
  editor,
  sourceUnavailable,
  multipleComments,
  onOpenSource,
  onEdit,
  onDelete,
  onSave,
  onEditorChange,
  onAnnouncement,
  openSourceButtonRef,
}: {
  readonly comment: SelectedTextComment;
  readonly editor?: SelectedTextCommentEditorDraft;
  readonly sourceUnavailable: boolean;
  readonly multipleComments: boolean;
  readonly onOpenSource: (comment: SelectedTextComment) => void;
  readonly onEdit: (comment: SelectedTextComment) => void;
  readonly onDelete: (comment: SelectedTextComment) => void;
  readonly onSave: (comment: SelectedTextComment) => void;
  readonly onEditorChange: (editor: SelectedTextCommentEditorDraft | undefined) => void;
  readonly onAnnouncement: (message: string) => void;
  readonly openSourceButtonRef: (element: HTMLElement | null) => void;
}) {
  const cardEditor = editor?.anchor === "card" && editor.commentId === comment.id ? editor : undefined;
  const itemRef = useRef<HTMLLIElement>(null);
  const actionCloseTimerRef = useRef<number | undefined>(undefined);
  const [areActionsVisible, setAreActionsVisible] = useState(false);
  const showActions = () => {
    if (actionCloseTimerRef.current !== undefined) window.clearTimeout(actionCloseTimerRef.current);
    setAreActionsVisible(true);
  };
  const hideActionsAfterFocusLeaves = () => {
    if (actionCloseTimerRef.current !== undefined) window.clearTimeout(actionCloseTimerRef.current);
    actionCloseTimerRef.current = window.setTimeout(() => {
      if (!itemRef.current?.contains(document.activeElement)) setAreActionsVisible(false);
    });
  };
  useEffect(() => () => {
    if (actionCloseTimerRef.current !== undefined) window.clearTimeout(actionCloseTimerRef.current);
  }, []);
  const content = (
    <div className="relative z-10 min-w-0 space-y-1 px-1 py-1.5 pointer-events-none">
      <p className="text-xs text-muted-foreground">{`${comment.displayNumber}. Selected text:`}</p>
      <QuotePreview quote={comment.source.quote} />
      {sourceUnavailable && <p className="text-xs text-muted-foreground">Source unavailable</p>}
      <p className="pt-1 text-xs text-muted-foreground">User comment:</p>
      <p className="whitespace-pre-wrap break-words text-sm leading-5">{comment.note}</p>
    </div>
  );

  return (
    <li
      ref={(element) => {
        itemRef.current = element;
        if (sourceUnavailable) openSourceButtonRef(element);
      }}
      tabIndex={sourceUnavailable ? 0 : undefined}
      className="relative min-w-0 border-b border-border/60 py-2 pr-12 first:pt-1 last:border-b-0 last:pb-1 focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      data-testid={`selected-text-comment-preview-item-${comment.displayNumber}`}
      onPointerEnter={showActions}
      onPointerLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        hideActionsAfterFocusLeaves();
      }}
      onFocus={showActions}
      onBlur={hideActionsAfterFocusLeaves}
    >
      {cardEditor ? (
        <>
          {content}
          <div className="mt-2">
            <SelectedTextCommentEditor
              key={comment.id}
              source={comment.source}
              comment={comment}
              draft={cardEditor}
              onSave={onSave}
              onDelete={onDelete}
              onDraftChange={onEditorChange}
              onClose={() => onEditorChange(undefined)}
              onAnnouncement={onAnnouncement}
            />
          </div>
        </>
      ) : (
        <>
          {content}
          {!sourceUnavailable && (
            <Button
              ref={openSourceButtonRef}
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Open source for comment ${comment.displayNumber}`}
              onClick={() => onOpenSource(comment)}
              className="absolute inset-0 z-0 h-auto w-full rounded-md p-0 focus-visible:z-10"
            />
          )}
          {areActionsVisible && (
            <div className="absolute top-2 right-0 z-20 flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Edit comment ${comment.displayNumber}`}
                      onClick={() => onEdit(comment)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Pencil size={14} aria-hidden />
                    </Button>
                  }
                />
                <TooltipContent side="top" sideOffset={4}>Edit comment {comment.displayNumber}</TooltipContent>
              </Tooltip>
              {multipleComments && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete comment ${comment.displayNumber}`}
                        onClick={() => onDelete(comment)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X size={14} aria-hidden />
                      </Button>
                    }
                  />
                  <TooltipContent side="top" sideOffset={4}>Delete comment {comment.displayNumber}</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}

/** Renders every saved selected-text comment as one aggregate composer attachment. */
export function SelectedTextCommentsComposerAttachment({
  comments,
  editor,
  unavailableSourceCommentIds = [],
  onRemove,
  onOpenSource,
  onEdit,
  onDelete,
  onFocusComposer,
  onSave,
  onEditorChange,
}: SelectedTextCommentsComposerAttachmentProps) {
  const [announcement, setAnnouncement] = useState("");
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const previewRootRef = useRef<HTMLDivElement>(null);
  const previewCloseTimerRef = useRef<number | undefined>(undefined);
  const focusAfterDeleteRef = useRef<string | undefined>(undefined);
  const openSourceButtonsRef = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const nextCommentId = focusAfterDeleteRef.current;
    if (!nextCommentId) return;
    focusAfterDeleteRef.current = undefined;
    openSourceButtonsRef.current.get(nextCommentId)?.focus();
  }, [comments]);
  useEffect(() => () => {
    if (previewCloseTimerRef.current !== undefined) window.clearTimeout(previewCloseTimerRef.current);
  }, []);
  const label = annotationLabel(comments.length);
  const dockedEditor = editor?.anchor === "card" && !comments.some(
    (comment) => comment.id === editor.commentId,
  )
    ? editor
    : undefined;
  const handleDelete = (comment: SelectedTextComment) => {
    const index = comments.findIndex((candidate) => candidate.id === comment.id);
    const nextFocusTarget = comments[index + 1] ?? comments[index - 1];
    focusAfterDeleteRef.current = nextFocusTarget?.id;
    setAnnouncement("Comment deleted.");
    if (!nextFocusTarget) onFocusComposer();
    onDelete(comment);
  };
  const openPreview = () => {
    if (previewCloseTimerRef.current !== undefined) window.clearTimeout(previewCloseTimerRef.current);
    setIsPreviewOpen(true);
  };
  const schedulePreviewClose = () => {
    if (previewCloseTimerRef.current !== undefined) window.clearTimeout(previewCloseTimerRef.current);
    previewCloseTimerRef.current = window.setTimeout(() => {
      if (!previewRootRef.current?.contains(document.activeElement)) setIsPreviewOpen(false);
    }, 100);
  };
  const closePreviewAfterFocusLeaves = () => {
    queueMicrotask(schedulePreviewClose);
  };

  return (
    <>
      {comments.length > 0 && (
        <section className="px-3 pt-2" aria-label="Selected text annotations" data-testid="selected-text-comment-attachment">
          <div
            ref={previewRootRef}
            className="relative inline-flex max-w-full"
            onPointerLeave={schedulePreviewClose}
            onBlur={closePreviewAfterFocusLeaves}
          >
            <div className="inline-flex h-8 max-w-full items-center overflow-hidden rounded-lg border border-border bg-background focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50" data-testid="selected-text-comment-chip">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`${label}. Preview available.`}
                aria-controls="selected-text-comment-preview"
                aria-expanded={isPreviewOpen}
                onPointerEnter={openPreview}
                onFocus={openPreview}
                onClick={openPreview}
                className="min-w-0 rounded-none border-y-0 border-l-0 border-r border-border bg-transparent px-3 text-foreground hover:bg-muted focus-visible:z-10"
              >
                <MessageCircle size={16} aria-hidden />
                <span className="min-w-0 truncate">{label}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${label}`}
                onClick={onRemove}
                className="rounded-none border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:z-10"
              >
                <X size={16} aria-hidden />
              </Button>
            </div>
            {isPreviewOpen && (
              <div
                id="selected-text-comment-preview"
                aria-label={`${label} preview`}
                className="absolute bottom-[calc(100%+0.25rem)] left-0 z-50 w-[min(38rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-md"
                data-testid="selected-text-comment-preview"
                onPointerEnter={openPreview}
                onFocus={openPreview}
                onPointerLeave={schedulePreviewClose}
              >
                <ol className="min-w-0">
                  {comments.map((comment) => (
                    <CommentPreviewItem
                      key={comment.id}
                      comment={comment}
                      editor={editor}
                      sourceUnavailable={unavailableSourceCommentIds.includes(comment.id)}
                      multipleComments={comments.length > 1}
                      onOpenSource={onOpenSource}
                      onEdit={onEdit}
                      onDelete={handleDelete}
                      onSave={onSave}
                      onEditorChange={onEditorChange}
                      onAnnouncement={setAnnouncement}
                      openSourceButtonRef={(element) => {
                        if (element) openSourceButtonsRef.current.set(comment.id, element);
                        else openSourceButtonsRef.current.delete(comment.id);
                      }}
                    />
                  ))}
                </ol>
              </div>
            )}
          </div>
        </section>
      )}
      {dockedEditor && (
        <section className="px-3 pt-2" aria-label="Selected text comment editor" data-testid="selected-text-comment-docked-editor">
          <div className="rounded-xl border border-border bg-muted/30 p-2">
            <p className="mb-2 text-xs text-muted-foreground">Source unavailable</p>
            <SelectedTextCommentEditor
              source={dockedEditor.source}
              draft={dockedEditor}
              nextDisplayNumber={comments.length + 1}
              onSave={onSave}
              onDraftChange={onEditorChange}
              onClose={() => onEditorChange(undefined)}
              onAnnouncement={setAnnouncement}
            />
          </div>
        </section>
      )}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </>
  );
}
