import { useEffect, useMemo, useState, type RefObject } from "react";
import type { SelectedTextComment } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import type { SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import {
  findSelectedTextCommentContent,
  reconstructCanonicalMessageRange,
} from "../selected-text-projection";
import {
  isSelectedTextCommentHighlightActive,
  placeSelectedTextCommentMarkers,
  type SelectedTextCommentMarkerRect,
} from "./selected-text-comment-marker-layout";

const EMPTY_SELECTED_TEXT_COMMENTS: readonly SelectedTextComment[] = [];

interface CommentOverlayGeometry {
  readonly comment: SelectedTextComment;
  readonly rects: readonly SelectedTextCommentMarkerRect[];
  readonly markerRect: SelectedTextCommentMarkerRect;
}

interface MarkerOverlayLayout {
  readonly root: DOMRect;
  readonly viewport: DOMRect;
}

function transcriptRect(rect: DOMRect, root: DOMRect): SelectedTextCommentMarkerRect {
  return {
    top: rect.top - root.top,
    right: rect.right - root.left,
    bottom: rect.bottom - root.top,
    left: rect.left - root.left,
    width: rect.width,
    height: rect.height,
  };
}

function visibleTranscriptRects(range: Range, viewport: DOMRect, root: DOMRect) {
  return [...range.getClientRects()]
    .map((rect) => ({
      top: Math.max(rect.top, viewport.top),
      right: Math.min(rect.right, viewport.right),
      bottom: Math.min(rect.bottom, viewport.bottom),
      left: Math.max(rect.left, viewport.left),
    }))
    .filter((rect) => rect.right > rect.left && rect.bottom > rect.top)
    .map((rect) => transcriptRect(
      new DOMRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top),
      root,
    ));
}

function commentOverlayGeometry(
  comment: SelectedTextComment,
  viewport: HTMLElement,
  renderedThreadId: string | null | undefined,
  root: DOMRect,
): CommentOverlayGeometry | null {
  const content = findSelectedTextCommentContent(comment.source, viewport, renderedThreadId);
  if (!content) return null;
  const range = reconstructCanonicalMessageRange(
    content,
    comment.source.start,
    comment.source.end,
    comment.source.quote,
  );
  if (!range) return null;
  const rects = visibleTranscriptRects(range, viewport.getBoundingClientRect(), root);
  const markerRect = rects.at(-1);
  return markerRect ? { comment, rects, markerRect } : null;
}

/** Props for saved comment highlights and source markers in the transcript overlay. */
export interface SelectedTextCommentMarkersProps {
  /** Scroll viewport that clips source highlights and marker positions. */
  readonly viewportRef: RefObject<HTMLElement | null>;
  /** Thread whose transcript is currently rendered. */
  readonly renderedThreadId: string | null | undefined;
  /** Open unsaved editor whose source remains visible while the user writes a note. */
  readonly editor?: SelectedTextCommentEditorDraft;
  /** Starts source navigation that opens this saved comment's source editor. */
  readonly onOpenComment: (comment: SelectedTextComment) => void;
}

/** Renders one source highlight and focusable marker for each visible saved comment. */
export function SelectedTextCommentMarkers({
  viewportRef,
  renderedThreadId,
  editor,
  onOpenComment,
}: SelectedTextCommentMarkersProps) {
  const comments = useComposerDraftStore((state) => (
    renderedThreadId
      ? state.drafts[renderedThreadId]?.selectedTextComments ?? EMPTY_SELECTED_TEXT_COMMENTS
      : EMPTY_SELECTED_TEXT_COMMENTS
  ));
  const [layout, setLayout] = useState<MarkerOverlayLayout | null>(null);
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);
  const pendingComment = useMemo(() => (
    editor
      && !editor.commentId
      && editor.anchor === "source"
      && editor.source.threadId === renderedThreadId
      ? {
        id: "pending-selected-text-comment",
        displayNumber: comments.length + 1,
        source: editor.source,
        note: editor.note,
        mentions: editor.mentions,
      }
      : undefined
  ), [comments.length, editor, renderedThreadId]);
  const visibleComments = useMemo(
    () => pendingComment ? [...comments, pendingComment] : comments,
    [comments, pendingComment],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = viewport.parentElement?.getBoundingClientRect();
        setLayout(root ? { root, viewport: viewport.getBoundingClientRect() } : null);
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh);
    observer?.observe(viewport);
    refresh();
    viewport.addEventListener("scroll", refresh, { passive: true });
    window.addEventListener("resize", refresh);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      viewport.removeEventListener("scroll", refresh);
      window.removeEventListener("resize", refresh);
    };
  }, [renderedThreadId, viewportRef]);

  const { geometries, markers } = useMemo(() => {
    const viewport = viewportRef.current;
    if (!viewport || !layout) return { geometries: [], markers: [] };
    const geometries = visibleComments
      .map((comment) => commentOverlayGeometry(comment, viewport, renderedThreadId, layout.root))
      .filter((geometry): geometry is CommentOverlayGeometry => geometry !== null);
    const markers = placeSelectedTextCommentMarkers(
      geometries.map(({ comment, markerRect }) => ({
        commentId: comment.id,
        displayNumber: comment.displayNumber,
        sourceRect: markerRect,
      })),
      {
        top: layout.viewport.top - layout.root.top,
        right: layout.viewport.right - layout.root.left,
        bottom: layout.viewport.bottom - layout.root.top,
        left: layout.viewport.left - layout.root.left,
      },
    );
    return { geometries, markers };
  }, [layout, renderedThreadId, viewportRef, visibleComments]);

  const commentsById = useMemo(
    () => new Map(visibleComments.map((comment) => [comment.id, comment])),
    [visibleComments],
  );
  const activeCommentId = focusedCommentId ?? hoveredCommentId;

  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-[1] overflow-hidden" aria-hidden="true">
        {geometries.map(({ comment, rects }) => {
          const isActive = isSelectedTextCommentHighlightActive(comment.id, activeCommentId);
          return (
            <div key={comment.id} data-testid="selected-text-comment-highlight" data-selected-text-comment-id={comment.id}>
              {rects.map((rect, index) => (
                <div
                  key={index}
                  className={cn("absolute rounded-sm bg-primary/15", isActive && "bg-primary/30 ring-1 ring-primary/40")}
                  style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="pointer-events-none absolute inset-0 z-[2] overflow-hidden">
        {markers.map((marker) => {
          const comment = commentsById.get(marker.commentId);
          if (!comment) return null;
          if (comment === pendingComment) {
            return (
              <span
                key={marker.commentId}
                data-testid="selected-text-comment-pending-marker"
                aria-hidden="true"
                className="absolute flex size-8 items-center justify-center rounded-full bg-primary/80 text-xs font-semibold leading-none text-primary-foreground shadow-sm ring-1 ring-background/80 tabular-nums"
                style={{ top: marker.top, left: marker.left }}
              >
                {marker.displayNumber}
              </span>
            );
          }
          return (
            <Button
              key={marker.commentId}
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="selected-text-comment-marker"
              data-selected-text-comment-marker-id={marker.commentId}
              aria-label={`Open comment ${marker.displayNumber}`}
              className="pointer-events-auto absolute flex size-8 items-center justify-center rounded-full bg-primary/80 p-0 text-primary-foreground shadow-sm ring-1 ring-background/80 hover:bg-primary focus-visible:bg-primary"
              style={{ top: marker.top, left: marker.left }}
              onMouseEnter={() => setHoveredCommentId(marker.commentId)}
              onMouseLeave={() => setHoveredCommentId((current) => current === marker.commentId ? null : current)}
              onFocus={() => setFocusedCommentId(marker.commentId)}
              onBlur={() => setFocusedCommentId((current) => current === marker.commentId ? null : current)}
              onClick={() => onOpenComment(comment)}
            >
              <span className="text-xs font-semibold leading-none tabular-nums">{marker.displayNumber}</span>
            </Button>
          );
        })}
      </div>
    </>
  );
}
