import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { SelectedTextComment } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import {
  useComposerDraftStore,
  type SelectedTextCommentEditorDraft,
} from "@/stores/composerDraftStore";
import { Popover, PopoverContent } from "@/components/ui/popover";
import {
  createSelectedTextCommentSource,
  findSelectedTextCommentContent,
  lastVisibleRangeRect,
  reconstructCanonicalMessageRange,
  type SelectedTextCommentSource,
} from "../selected-text-projection";
import {
  placeSelectedTextCommentEditor,
  type CommentEditorSourcePosition,
} from "./comment-editor-placement";
import { SelectedTextCommentEditor } from "./SelectedTextCommentEditor";

/** Suggestion scope for the selected-text comment editor. */
export interface SelectedTextCommentEditorScope {
  readonly workspaceId?: string;
  readonly providerId?: string;
}

/** Props for {@link SelectedTextCommentControls}. */
export interface SelectedTextCommentControlsProps {
  /** Adds the captured selected-text comment to the active composer draft. */
  onSelectedTextComment?: (comment: SelectedTextComment) => void;
  /** Saved comments that let this control restore and update an editor target. */
  comments?: readonly SelectedTextComment[];
  /** Per-thread open-editor state restored from the ComposerDraft. */
  editor?: SelectedTextCommentEditorDraft;
  /** Stores or clears the open editor snapshot in the current ComposerDraft. */
  onSelectedTextCommentEditorChange?: (editor: SelectedTextCommentEditorDraft | undefined) => void;
  /** Scopes typed mention and slash-skill suggestions to the active thread. */
  selectedTextCommentEditorScope?: SelectedTextCommentEditorScope;
  /** Scroll viewport that bounds the selected range and Popover collision area. */
  viewportRef: RefObject<HTMLElement | null>;
  /** Thread whose transcript is currently rendered in the viewport. */
  renderedThreadId: string | null | undefined;
  /** Current resident message order, used only while a virtualized source is unmounted. */
  messageIds: readonly string[];
}

type CommentOverlay = {
  readonly source: SelectedTextCommentSource;
  readonly stage: "action" | "editor";
  readonly editor?: SelectedTextCommentEditorDraft;
};

const EMPTY_SELECTED_TEXT_COMMENTS: readonly SelectedTextComment[] = [];
type VirtualAnchor = {
  readonly getBoundingClientRect: () => DOMRect;
};

type CurrentPlacement = {
  readonly anchor: DOMRect;
  readonly width: number;
  readonly maxHeight: number;
};

type SourcePositionHistory = {
  lastVisibleScrollTop: number | null;
  lastDockedEdge: "top" | "bottom" | null;
  isDocked: boolean;
};

// Matches the empty compact editor shell before its first layout measurement.
const INITIAL_EDITOR_HEIGHT = 46;

function sourceEdgeFromRange(range: Range, viewport: DOMRect): "top" | "bottom" | null {
  const rects = [...range.getClientRects()];
  if (rects.length === 0) return null;
  if (rects.every((rect) => rect.bottom <= viewport.top)) return "top";
  if (rects.every((rect) => rect.top >= viewport.bottom)) return "bottom";

  const topDistance = Math.min(...rects.map((rect) => Math.abs(viewport.top - rect.bottom)));
  const bottomDistance = Math.min(...rects.map((rect) => Math.abs(rect.top - viewport.bottom)));
  return topDistance <= bottomDistance ? "top" : "bottom";
}

/** Resolves the dock edge after a source leaves the rendered transcript. */
export function sourceEdgeAfterScrollDeparture(
  history: SourcePositionHistory,
  scrollTop: number,
): "top" | "bottom" {
  if (history.isDocked && history.lastDockedEdge) return history.lastDockedEdge;
  if (history.lastVisibleScrollTop === null) return history.lastDockedEdge ?? "bottom";
  if (scrollTop > history.lastVisibleScrollTop) return "top";
  if (scrollTop < history.lastVisibleScrollTop) return "bottom";
  return history.lastDockedEdge ?? "bottom";
}

function currentSourcePosition(
  source: SelectedTextCommentSource,
  viewport: HTMLElement,
  renderedThreadId: string | null | undefined,
  messageIds: readonly string[],
  history: SourcePositionHistory,
): CommentEditorSourcePosition | null {
  if (source.threadId !== renderedThreadId || !messageIds.includes(source.messageId)) return null;
  const content = findSelectedTextCommentContent(source, viewport, renderedThreadId);
  if (!content) {
    const edge = sourceEdgeAfterScrollDeparture(history, viewport.scrollTop);
    history.lastDockedEdge = edge;
    history.isDocked = true;
    return { kind: "docked", edge };
  }

  const range = reconstructCanonicalMessageRange(content, source.start, source.end, source.quote);
  if (!range) return null;
  const visibleRect = lastVisibleRangeRect(range, viewport);
  const rangeEdge = sourceEdgeFromRange(range, viewport.getBoundingClientRect());
  if (visibleRect) {
    history.lastVisibleScrollTop = viewport.scrollTop;
    history.lastDockedEdge = rangeEdge;
    history.isDocked = false;
    return { kind: "visible", rect: visibleRect };
  }

  const edge = rangeEdge ?? sourceEdgeAfterScrollDeparture(history, viewport.scrollTop);
  history.lastDockedEdge = edge;
  history.isDocked = true;
  return { kind: "docked", edge };
}

/** Renders transcript selection actions and the selected-text comment editor. */
export function SelectedTextCommentControls({
  onSelectedTextComment,
  comments,
  editor,
  onSelectedTextCommentEditorChange,
  selectedTextCommentEditorScope,
  viewportRef,
  renderedThreadId,
  messageIds,
}: SelectedTextCommentControlsProps) {
  const draftComments = useComposerDraftStore((state) =>
    renderedThreadId
      ? state.drafts[renderedThreadId]?.selectedTextComments ?? EMPTY_SELECTED_TEXT_COMMENTS
      : EMPTY_SELECTED_TEXT_COMMENTS,
  );
  const activeComments = comments ?? draftComments;
  const [overlay, setOverlay] = useState<CommentOverlay | null>(null);
  const restoredOverlay = useMemo(() => (
    editor?.anchor === "source" && editor.source.threadId === renderedThreadId
      ? { source: editor.source, stage: "editor" as const, editor }
      : null
  ), [editor, renderedThreadId]);
  const activeOverlay = overlay ?? restoredOverlay;
  const [, setLayoutVersion] = useState(0);
  const actionButtonRef = useRef<HTMLButtonElement | null>(null);
  const editorElementRef = useRef<HTMLElement | null>(null);
  const editorResizeObserverRef = useRef<ResizeObserver | null>(null);
  const sourcePositionHistoryRef = useRef<SourcePositionHistory>({
    lastVisibleScrollTop: null,
    lastDockedEdge: null,
    isDocked: false,
  });
  const ignoreSelectionClickDismissalRef = useRef(false);
  const [announcement, setAnnouncement] = useState("");

  const resolveSourcePosition = useCallback((source: SelectedTextCommentSource) => {
    const viewport = viewportRef.current;
    return viewport
      ? currentSourcePosition(source, viewport, renderedThreadId, messageIds, sourcePositionHistoryRef.current)
      : null;
  }, [messageIds, renderedThreadId, viewportRef]);

  const closeOverlay = useCallback((clearEditor = false) => {
    ignoreSelectionClickDismissalRef.current = false;
    setOverlay(null);
    if (clearEditor) onSelectedTextCommentEditorChange?.(undefined);
  }, [onSelectedTextCommentEditorChange]);

  const openAction = useCallback((source: SelectedTextCommentSource) => {
    sourcePositionHistoryRef.current = {
      lastVisibleScrollTop: null,
      lastDockedEdge: null,
      isDocked: false,
    };
    if (!resolveSourcePosition(source)) return;
    ignoreSelectionClickDismissalRef.current = true;
    window.setTimeout(() => {
      ignoreSelectionClickDismissalRef.current = false;
    }, 0);
    setOverlay({ source, stage: "action" });
  }, [resolveSourcePosition]);

  const setEditorElement = useCallback((element: HTMLElement | null) => {
    if (editorElementRef.current === element) return;
    editorResizeObserverRef.current?.disconnect();
    editorElementRef.current = element;
    if (element && typeof ResizeObserver !== "undefined") {
      editorResizeObserverRef.current = new ResizeObserver(() => setLayoutVersion((version) => version + 1));
      editorResizeObserverRef.current.observe(element);
    }
  }, []);

  useEffect(() => () => editorResizeObserverRef.current?.disconnect(), []);

  useEffect(() => {
    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const selection = window.getSelection();
      if (!selection) return;
      const source = createSelectedTextCommentSource(selection, event.target);
      if (source) openAction(source);
    };

    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, [openAction]);

  useEffect(() => {
    if (overlay?.stage !== "action") return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-slot="popover-content"]')) return;
      closeOverlay();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeOverlay();
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeOverlay, overlay?.stage]);

  useEffect(() => {
    if (!activeOverlay) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    let observedSource: HTMLElement | null = null;
    let frame = 0;
    const refresh = () => {
      const content = findSelectedTextCommentContent(activeOverlay.source, viewport, renderedThreadId);
      if (content !== observedSource) {
        if (observedSource) resizeObserver?.unobserve(observedSource);
        observedSource = content;
        if (content) resizeObserver?.observe(content);
      }
      if (!resolveSourcePosition(activeOverlay.source)) {
        closeOverlay();
        return;
      }
      setLayoutVersion((version) => version + 1);
    };
    const scheduleRefresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refresh);
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleRefresh);
    resizeObserver?.observe(viewport);
    scheduleRefresh();
    viewport.addEventListener("scroll", scheduleRefresh, { passive: true });
    window.addEventListener("resize", scheduleRefresh);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      viewport.removeEventListener("scroll", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
    };
  }, [activeOverlay, closeOverlay, renderedThreadId, resolveSourcePosition, viewportRef]);

  const currentPlacement = useCallback((nextOverlay: CommentOverlay): CurrentPlacement | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const source = resolveSourcePosition(nextOverlay.source);
    if (!source) return null;
    const editorHeight = editorElementRef.current?.getBoundingClientRect().height;
    const preferredWidth = nextOverlay.stage === "editor" ? 328 : 160;
    const preferredHeight = nextOverlay.stage === "editor"
      ? editorHeight ?? INITIAL_EDITOR_HEIGHT
      : 40;
    const placement = placeSelectedTextCommentEditor({
      viewport: viewport.getBoundingClientRect(),
      source,
      preferredWidth,
      editorHeight: preferredHeight,
    });
    const height = Math.min(preferredHeight, placement.maxHeight);
    return {
      anchor: new DOMRect(placement.left, placement.top - height, placement.width, height),
      width: placement.width,
      maxHeight: placement.maxHeight,
    };
  }, [resolveSourcePosition, viewportRef]);

  const openSelectedTextCommentEditor = useCallback(() => {
    if (!overlay || overlay.stage !== "action") return;
    const nextEditor: SelectedTextCommentEditorDraft = {
      source: overlay.source,
      note: "",
      mentions: [],
      escapeWarned: false,
      outsideWarned: false,
      anchor: "source",
    };
    setOverlay({ ...overlay, stage: "editor", editor: nextEditor });
    onSelectedTextCommentEditorChange?.(nextEditor);
    setAnnouncement("Comment editor opened.");
  }, [onSelectedTextCommentEditorChange, overlay]);

  const closeEditor = useCallback(({ restoreFocus = true }: { readonly restoreFocus?: boolean } = {}) => {
    if (!restoreFocus) {
      closeOverlay(true);
      return;
    }
    setOverlay((current) => current?.stage === "editor" ? { ...current, stage: "action" } : current);
    onSelectedTextCommentEditorChange?.(undefined);
    requestAnimationFrame(() => actionButtonRef.current?.focus());
  }, [closeOverlay, onSelectedTextCommentEditorChange]);

  const saveSelectedTextComment = useCallback((comment: SelectedTextComment) => {
    onSelectedTextComment?.(comment);
    onSelectedTextCommentEditorChange?.(undefined);
  }, [onSelectedTextComment, onSelectedTextCommentEditorChange]);

  const virtualAnchor: VirtualAnchor | null = activeOverlay ? {
    getBoundingClientRect: () => currentPlacement(activeOverlay)?.anchor ?? new DOMRect(),
  } : null;
  const editorPlacement = activeOverlay?.stage === "editor" ? currentPlacement(activeOverlay) : null;
  const editorStyle: CSSProperties | undefined = editorPlacement
    ? { width: editorPlacement.width, maxHeight: editorPlacement.maxHeight }
    : undefined;

  return (
    <>
      <SelectedTextCommentPopover
        overlay={activeOverlay}
        virtualAnchor={virtualAnchor}
        viewportRef={viewportRef}
        ignoreSelectionClickDismissalRef={ignoreSelectionClickDismissalRef}
        actionButtonRef={actionButtonRef}
        editorScope={selectedTextCommentEditorScope}
        editorStyle={editorStyle}
        onEditorElementChange={setEditorElement}
        onCloseEditor={closeEditor}
        comments={activeComments}
        onOpenEditor={openSelectedTextCommentEditor}
        onClose={() => closeOverlay(activeOverlay?.stage === "editor")}
        onSave={saveSelectedTextComment}
        onEditorChange={onSelectedTextCommentEditorChange}
        onAnnouncement={setAnnouncement}
      />
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </>
  );
}

function SelectedTextCommentPopover({
  overlay,
  virtualAnchor,
  viewportRef,
  ignoreSelectionClickDismissalRef,
  actionButtonRef,
  editorScope,
  editorStyle,
  onEditorElementChange,
  comments,
  onOpenEditor,
  onClose,
  onCloseEditor,
  onSave,
  onEditorChange,
  onAnnouncement,
}: {
  readonly overlay: CommentOverlay | null;
  readonly virtualAnchor: VirtualAnchor | null;
  readonly viewportRef: RefObject<HTMLElement | null>;
  readonly ignoreSelectionClickDismissalRef: Readonly<{ current: boolean }>;
  readonly actionButtonRef: RefObject<HTMLButtonElement | null>;
  readonly editorScope?: SelectedTextCommentEditorScope;
  readonly editorStyle?: CSSProperties;
  readonly onEditorElementChange: (element: HTMLElement | null) => void;
  readonly comments: readonly SelectedTextComment[];
  readonly onOpenEditor: () => void;
  readonly onClose: () => void;
  readonly onCloseEditor: (options?: { readonly restoreFocus?: boolean }) => void;
  readonly onSave: (comment: SelectedTextComment) => void;
  readonly onEditorChange?: (editor: SelectedTextCommentEditorDraft | undefined) => void;
  readonly onAnnouncement: (message: string) => void;
}) {
  if (!overlay || !virtualAnchor) return null;

  const handleOpenChange = (open: boolean) => {
    if (open || overlay.stage !== "action" || ignoreSelectionClickDismissalRef.current) return;
    onClose();
  };

  const content = overlay.stage === "action"
    ? (
      <PopoverContent
        key={overlay.stage}
        anchor={virtualAnchor}
        side="bottom"
        align="start"
        sideOffset={0}
        collisionBoundary={viewportRef.current ?? undefined}
        collisionPadding={0}
        collisionAvoidance={{ side: "none", align: "none", fallbackAxisSide: "none" }}
        positionMethod="fixed"
        finalFocus={false}
        className="!w-40 p-1"
      >
        <Button
          ref={actionButtonRef}
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={onOpenEditor}
        >
          Add comment
        </Button>
      </PopoverContent>
    )
    : (
      <PopoverContent
        key={overlay.stage}
        anchor={virtualAnchor}
        side="bottom"
        align="start"
        sideOffset={0}
        collisionBoundary={viewportRef.current ?? undefined}
        collisionPadding={0}
        collisionAvoidance={{ side: "none", align: "none", fallbackAxisSide: "none" }}
        positionMethod="fixed"
        initialFocus={() => document.getElementById("selected-text-comment-note")}
        finalFocus={false}
        style={editorStyle}
        className="border-0 bg-transparent p-0 shadow-none"
      >
        <SelectedTextCommentEditor
          key={`${overlay.source.messageId}:${overlay.source.start}:${overlay.source.end}`}
          source={overlay.source}
          comment={overlay.editor?.commentId
            ? comments.find((comment) => comment.id === overlay.editor?.commentId)
            : undefined}
          draft={overlay.editor}
          nextDisplayNumber={comments.length + 1}
          workspaceId={editorScope?.workspaceId}
          providerId={editorScope?.providerId}
          maxHeight={typeof editorStyle?.maxHeight === "number" ? editorStyle.maxHeight : undefined}
          onElementChange={onEditorElementChange}
          onSave={onSave}
          onDraftChange={onEditorChange}
          onClose={onCloseEditor}
          onAnnouncement={onAnnouncement}
        />
      </PopoverContent>
    );

  return (
    <Popover open modal={false} onOpenChange={handleOpenChange}>
      {content}
    </Popover>
  );
}
