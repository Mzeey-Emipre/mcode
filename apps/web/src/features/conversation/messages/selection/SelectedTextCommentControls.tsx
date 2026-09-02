import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { SelectedTextComment } from "@mcode/contracts";
import { Popover, PopoverContent } from "@/components/ui/popover";
import {
  createSelectedTextCommentSource,
  findSelectedTextCommentContent,
  lastVisibleRangeRect,
  reconstructCanonicalMessageRange,
  type SelectedTextCommentSource,
} from "../selected-text-projection";
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
  /** Scopes typed mention and slash-skill suggestions to the active thread. */
  selectedTextCommentEditorScope?: SelectedTextCommentEditorScope;
  /** Scroll viewport that bounds the selected range and Popover collision area. */
  viewportRef: RefObject<HTMLElement | null>;
  /** Thread whose transcript is currently rendered in the viewport. */
  renderedThreadId: string | null | undefined;
}

type CommentOverlay = {
  readonly source: SelectedTextCommentSource;
  readonly stage: "action" | "editor";
};

type CachedAnchor = {
  readonly rect: DOMRect;
  readonly scrollTop: number;
};

type VirtualAnchor = {
  readonly getBoundingClientRect: () => DOMRect;
};

function copyRect(rect: DOMRect): DOMRect {
  return new DOMRect(rect.x, rect.y, rect.width, rect.height);
}

/** Renders transcript selection actions and the selected-text comment editor. */
export function SelectedTextCommentControls({
  onSelectedTextComment,
  selectedTextCommentEditorScope,
  viewportRef,
  renderedThreadId,
}: SelectedTextCommentControlsProps) {
  const [overlay, setOverlay] = useState<CommentOverlay | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const cachedAnchorRef = useRef<CachedAnchor | null>(null);
  const ignoreSelectionClickDismissalRef = useRef(false);
  const [announcement, setAnnouncement] = useState("");

  const sourceRect = useCallback((source: SelectedTextCommentSource): DOMRect | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const content = findSelectedTextCommentContent(source, viewport, renderedThreadId);
    if (!content) return null;
    const range = reconstructCanonicalMessageRange(content, source.start, source.end, source.quote);
    const rect = range && lastVisibleRangeRect(range, viewport);
    return rect ? copyRect(rect) : null;
  }, [renderedThreadId, viewportRef]);

  const updateAnchor = useCallback((nextOverlay: CommentOverlay): boolean => {
    const viewport = viewportRef.current;
    if (!viewport) return false;
    const rect = sourceRect(nextOverlay.source);
    if (rect) {
      cachedAnchorRef.current = { rect, scrollTop: viewport.scrollTop };
      setAnchorRect(rect);
      return true;
    }
    if (nextOverlay.stage === "action") return false;
    const cached = cachedAnchorRef.current;
    if (!cached) return false;
    setAnchorRect(new DOMRect(
      cached.rect.x,
      cached.rect.y - (viewport.scrollTop - cached.scrollTop),
      cached.rect.width,
      cached.rect.height,
    ));
    return true;
  }, [sourceRect, viewportRef]);

  const closeOverlay = useCallback(() => {
    ignoreSelectionClickDismissalRef.current = false;
    cachedAnchorRef.current = null;
    setAnchorRect(null);
    setOverlay(null);
  }, []);

  const openAction = useCallback((source: SelectedTextCommentSource) => {
    const nextOverlay: CommentOverlay = { source, stage: "action" };
    if (!updateAnchor(nextOverlay)) return;
    ignoreSelectionClickDismissalRef.current = true;
    window.setTimeout(() => {
      ignoreSelectionClickDismissalRef.current = false;
    }, 0);
    setOverlay(nextOverlay);
  }, [updateAnchor]);

  useEffect(() => {
    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const selection = window.getSelection();
      if (!selection) return;
      const source = createSelectedTextCommentSource(selection, event.target);
      if (!source) return;
      openAction(source);
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
    if (!overlay) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    let observedSource: HTMLElement | null = null;
    const refresh = () => {
      const source = findSelectedTextCommentContent(overlay.source, viewport, renderedThreadId);
      if (source !== observedSource) {
        if (observedSource) resizeObserver?.unobserve(observedSource);
        observedSource = source;
        if (source) resizeObserver?.observe(source);
      }
      if (!updateAnchor(overlay)) closeOverlay();
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh);
    resizeObserver?.observe(viewport);
    const frame = requestAnimationFrame(refresh);
    viewport.addEventListener("scroll", refresh, { passive: true });
    window.addEventListener("resize", refresh);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      viewport.removeEventListener("scroll", refresh);
      window.removeEventListener("resize", refresh);
    };
  }, [closeOverlay, overlay, renderedThreadId, updateAnchor, viewportRef]);

  const openSelectedTextCommentEditor = useCallback(() => {
    if (!overlay || overlay.stage !== "action") return;
    setOverlay({ ...overlay, stage: "editor" });
    setAnnouncement("Comment editor opened.");
  }, [overlay]);

  const saveSelectedTextComment = useCallback((comment: SelectedTextComment) => {
    onSelectedTextComment?.(comment);
  }, [onSelectedTextComment]);

  const virtualAnchor = useMemo(() => anchorRect && ({
    getBoundingClientRect: () => anchorRect,
  }), [anchorRect]);

  return (
    <>
      <SelectedTextCommentPopover
        overlay={overlay}
        virtualAnchor={virtualAnchor}
        viewportRef={viewportRef}
        ignoreSelectionClickDismissalRef={ignoreSelectionClickDismissalRef}
        editorScope={selectedTextCommentEditorScope}
        onOpenEditor={openSelectedTextCommentEditor}
        onClose={closeOverlay}
        onSave={saveSelectedTextComment}
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
  editorScope,
  onOpenEditor,
  onClose,
  onSave,
  onAnnouncement,
}: {
  readonly overlay: CommentOverlay | null;
  readonly virtualAnchor: VirtualAnchor | null;
  readonly viewportRef: RefObject<HTMLElement | null>;
  readonly ignoreSelectionClickDismissalRef: Readonly<{ current: boolean }>;
  readonly editorScope?: SelectedTextCommentEditorScope;
  readonly onOpenEditor: () => void;
  readonly onClose: () => void;
  readonly onSave: (comment: SelectedTextComment) => void;
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
        anchor={virtualAnchor}
        side="bottom"
        align="start"
        sideOffset={8}
        collisionBoundary={viewportRef.current ?? undefined}
        collisionPadding={8}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        positionMethod="fixed"
        finalFocus={false}
        className="!w-40 p-1"
      >
        <button
          type="button"
          className="flex w-full rounded-md px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
          onClick={onOpenEditor}
        >
          Add comment
        </button>
      </PopoverContent>
    )
    : (
      <PopoverContent
        anchor={virtualAnchor}
        side="bottom"
        align="start"
        sideOffset={8}
        collisionBoundary={viewportRef.current ?? undefined}
        collisionPadding={8}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        positionMethod="fixed"
        sticky
        initialFocus={() => document.getElementById("selected-text-comment-note")}
        finalFocus={false}
        className="w-[min(328px,calc(100vw-16px))] border-0 bg-transparent p-0 shadow-none"
      >
        <SelectedTextCommentEditor
          key={`${overlay.source.messageId}:${overlay.source.start}:${overlay.source.end}`}
          source={overlay.source}
          workspaceId={editorScope?.workspaceId}
          providerId={editorScope?.providerId}
          onSave={onSave}
          onClose={onClose}
          onAnnouncement={onAnnouncement}
        />
      </PopoverContent>
    );

  return (
    <Popover
      open
      modal={false}
      onOpenChange={handleOpenChange}
    >
      {content}
    </Popover>
  );
}
