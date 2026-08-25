import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { create } from "zustand";
import { Check, MessageCircle, X } from "lucide-react";
import { ComposerEditor } from "@/components/chat/lexical/ComposerEditor";
import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** A text range in an actual rendered conversation message. */
export interface SelectedTextSource {
  messageId: string;
  threadId: string;
  start: number;
  end: number;
  quote: string;
}

interface PrototypeDraft {
  id: number;
  source: SelectedTextSource;
  note: string;
  savedNote: string;
  open: boolean;
}

interface PrototypeMenu {
  x: number;
  y: number;
  source: SelectedTextSource;
}

interface SelectedTextPrototypeState {
  menu: PrototypeMenu | null;
  drafts: PrototypeDraft[];
  editorId: number | null;
  warningMethod: "escape" | "outside" | null;
  nextId: number;
  setMenu: (menu: PrototypeMenu | null) => void;
  addDraft: (source: SelectedTextSource) => number;
  openDraft: (id: number) => void;
  closeEditor: () => void;
  setNote: (id: number, note: string) => void;
  saveDraft: (id: number) => void;
  deleteDraft: (id: number) => void;
  setWarningMethod: (method: "escape" | "outside" | null) => void;
}

/** Returns whether the dev-only selected-text comments prototype is active. */
export function isSelectedTextCommentsPrototypeEnabled(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get("prototype") === "selected-text-comments";
}

const useSelectedTextPrototypeStore = create<SelectedTextPrototypeState>((set) => ({
  menu: null,
  drafts: [],
  editorId: null,
  warningMethod: null,
  nextId: 1,
  setMenu: (menu) => set({ menu }),
  addDraft: (source) => {
    let id = 0;
    set((state) => {
      id = state.nextId;
      return {
        nextId: state.nextId + 1,
        menu: null,
        editorId: id,
        warningMethod: null,
        drafts: [...state.drafts, { id, source, note: "", savedNote: "", open: true }],
      };
    });
    return id;
  },
  openDraft: (id) => set((state) => ({
    editorId: id,
    warningMethod: null,
    menu: null,
    drafts: state.drafts.map((draft) => draft.id === id ? { ...draft, open: true } : draft),
  })),
  closeEditor: () => set({ editorId: null, warningMethod: null }),
  setNote: (id, note) => set((state) => ({
    warningMethod: null,
    drafts: state.drafts.map((draft) => draft.id === id ? { ...draft, note, open: true } : draft),
  })),
  saveDraft: (id) => set((state) => ({
    editorId: state.editorId === id ? null : state.editorId,
    warningMethod: null,
    drafts: state.drafts.map((draft) => {
      if (draft.id !== id) return draft;
      const note = draft.note.trim();
      return { ...draft, note, savedNote: note, open: false };
    }),
  })),
  deleteDraft: (id) => set((state) => ({
    editorId: state.editorId === id ? null : state.editorId,
    warningMethod: null,
    drafts: state.drafts.filter((draft) => draft.id !== id),
  })),
  setWarningMethod: (warningMethod) => set({ warningMethod }),
}));

function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

function offsetForPoint(root: HTMLElement, node: Node, offset: number): number | null {
  if (!root.contains(node) && node !== root) return null;
  try {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, Math.max(0, offset));
    return range.toString().length;
  } catch {
    return null;
  }
}

function pointForOffset(root: HTMLElement, offset: number): [Text, number] | null {
  const nodes = textNodes(root);
  let remaining = Math.max(0, Math.min(offset, root.textContent?.length ?? 0));
  for (const node of nodes) {
    if (remaining <= node.data.length) return [node, remaining];
    remaining -= node.data.length;
  }
  const last = nodes[nodes.length - 1];
  return last ? [last, last.data.length] : null;
}

function findSourceElement(source: Pick<SelectedTextSource, "messageId" | "threadId">): HTMLElement | null {
  const elements = document.querySelectorAll<HTMLElement>("[data-prototype-source]");
  return Array.from(elements).find((element) =>
    element.dataset.messageId === source.messageId && element.dataset.threadId === source.threadId,
  ) ?? null;
}

function sourceFromSelection(root: HTMLElement, selection: Selection): SelectedTextSource | null {
  if (!selection.rangeCount || selection.isCollapsed || !selection.toString().trim()) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const start = offsetForPoint(root, range.startContainer, range.startOffset);
  const end = offsetForPoint(root, range.endContainer, range.endOffset);
  const messageId = root.dataset.messageId;
  const threadId = root.dataset.threadId;
  if (start == null || end == null || !messageId || !threadId || start === end) return null;
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  return { messageId, threadId, start: low, end: high, quote: root.textContent?.slice(low, high) ?? selection.toString() };
}

function rangeForSource(source: SelectedTextSource): Range | null {
  const root = findSourceElement(source);
  if (!root) return null;
  const start = pointForOffset(root, source.start);
  const end = pointForOffset(root, source.end);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start[0], start[1]);
  range.setEnd(end[0], end[1]);
  return range;
}

function rangeRects(source: SelectedTextSource): DOMRect[] {
  const range = rangeForSource(source);
  return range ? Array.from(range.getClientRects()) : [];
}

function rootRect(container: HTMLElement): DOMRect {
  return container.parentElement?.getBoundingClientRect() ?? container.getBoundingClientRect();
}

function clampPosition(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

function sourceRootFromTarget(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>("[data-prototype-source]")
    ?? element?.querySelector<HTMLElement>("[data-prototype-source]")
    ?? null;
}

function prototypeDraftIsDirty(draft: PrototypeDraft): boolean {
  return draft.note !== draft.savedNote;
}

function DraftEditor({
  draft,
  containerRef,
}: {
  draft: PrototypeDraft;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const warningMethod = useSelectedTextPrototypeStore((state) => state.warningMethod);
  const setNote = useSelectedTextPrototypeStore((state) => state.setNote);
  const saveDraft = useSelectedTextPrototypeStore((state) => state.saveDraft);
  const editorRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; dock: "anchored" | "top" | "bottom" }>({ top: 16, left: 16, width: 328, dock: "top" });

  useEffect(() => {
    const update = () => {
      const viewport = containerRef.current;
      const editor = editorRef.current;
      if (!viewport || !editor) return;
      const outer = rootRect(viewport);
      const viewportRect = viewport.getBoundingClientRect();
      const rects = rangeRects(draft.source);
      const visibleRects = rects.filter((rect) => (
        rect.right > viewportRect.left && rect.left < viewportRect.right &&
        rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
      ));
      const sourceRect = visibleRects[visibleRects.length - 1]
        ?? rects[rects.length - 1]
        ?? findSourceElement(draft.source)?.getBoundingClientRect();
      const height = editor.offsetHeight || 48;
      const gap = 8;
      const width = Math.min(328, Math.max(0, viewport.clientWidth - 16));
      const bottomInset = 56;
      const viewportTop = viewportRect.top - outer.top;
      const viewportLeft = viewportRect.left - outer.left;
      const viewportBottom = viewportRect.bottom - outer.top;
      const viewportRight = viewportRect.right - outer.left;
      let dock: "anchored" | "top" | "bottom" = "anchored";
      let top = sourceRect ? sourceRect.bottom - outer.top + gap : viewportTop + gap;
      if (!sourceRect || sourceRect.bottom <= viewportRect.top || sourceRect.top >= viewportRect.bottom) {
        dock = sourceRect && sourceRect.top < viewportRect.top ? "top" : "bottom";
        top = dock === "top" ? viewportTop + gap : viewportBottom - height - gap - bottomInset;
      } else if (top + height > viewportBottom - bottomInset && sourceRect.top - outer.top - height - gap >= viewportTop) {
        top = sourceRect.top - outer.top - height - gap;
      }
      const left = sourceRect
        ? sourceRect.left - outer.left
        : viewportLeft + Math.max(gap, viewport.clientWidth - width - gap);
      setPosition({
        top: clampPosition(top, viewportTop + gap, viewportBottom - height - gap - bottomInset),
        left: clampPosition(left, viewportLeft + gap, viewportRight - width - gap),
        width,
        dock,
      });
    };
    update();
    const viewport = containerRef.current;
    viewport?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const frame = requestAnimationFrame(update);
    return () => {
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      cancelAnimationFrame(frame);
    };
  }, [containerRef, draft.source, draft.note, warningMethod]);

  const dismiss = useCallback((method: "escape" | "outside") => {
    const state = useSelectedTextPrototypeStore.getState();
    const currentDraft = state.drafts.find((candidate) => candidate.id === draft.id);
    if (!currentDraft) return;
    if (prototypeDraftIsDirty(currentDraft)) {
      if (state.warningMethod === method) state.deleteDraft(draft.id);
      else state.setWarningMethod(method);
      return;
    }
    state.closeEditor();
  }, [draft.id]);
  const canSave = draft.note.trim().length > 0;

  return (
    <div
      ref={editorRef}
      className={cn(
        "absolute z-40 overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-lg",
        warningMethod && "animate-preview-annotation-shake",
      )}
      style={{ top: position.top, left: position.left, width: position.width }}
      data-prototype-editor-dock={position.dock}
      data-prototype-editor="true"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 px-2 py-1">
        <div className="min-w-0 flex-1 overflow-hidden">
          <ComposerEditor
            key={draft.id}
            compact
            autoFocus
            initialText={draft.note}
            maxLength={2000}
            submitShortcut="mod-enter"
            placeholder="Write a note"
            ariaLabel="Comment note"
            title="Ctrl/Cmd+Enter saves"
            onChange={(text) => setNote(draft.id, text)}
            onSubmit={() => {
              const currentDraft = useSelectedTextPrototypeStore.getState().drafts.find((candidate) => candidate.id === draft.id);
              if (currentDraft?.note.trim()) saveDraft(draft.id);
            }}
            onEscape={() => dismiss("escape")}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon-xs" className="rounded-full" aria-label="Close comment editor" title="Close comment editor" onClick={() => dismiss("outside")}>
            <X size={14} aria-hidden />
          </Button>
          {canSave && <Button type="button" variant="default" size="icon-xs" className="rounded-full" aria-label="Save comment" title="Save comment" onClick={() => saveDraft(draft.id)}>
            <Check size={13} aria-hidden />
          </Button>}
        </div>
      </div>
    </div>
  );
}

function PrototypeContextMenu() {
  const menu = useSelectedTextPrototypeStore((state) => state.menu);
  const setMenu = useSelectedTextPrototypeStore((state) => state.setMenu);
  const addDraft = useSelectedTextPrototypeStore((state) => state.addDraft);

  if (!menu) return null;

  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={[
        { label: "Add comment", onClick: () => addDraft(menu.source) },
        { label: "Copy", onClick: () => void navigator.clipboard?.writeText(menu.source.quote) },
      ]}
      onClose={() => setMenu(null)}
    />
  );
}

function NumberedCommentIcon({ displayNumber, className }: { displayNumber: number; className?: string }) {
  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center rounded-full bg-primary/80 text-primary-foreground/90 shadow-sm ring-1 ring-background/80", className)} aria-hidden>
      <span className="absolute -bottom-0.5 left-1.5 size-2 rotate-45 rounded-sm bg-primary/80" />
      <span className="relative z-10 text-xs font-semibold leading-none tabular-nums">
        {displayNumber}
      </span>
    </span>
  );
}

function PrototypeOverlay({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const drafts = useSelectedTextPrototypeStore((state) => state.drafts);
  const editorId = useSelectedTextPrototypeStore((state) => state.editorId);
  const [version, setVersion] = useState(0);
  const container = containerRef.current;
  const outer = container ? rootRect(container) : null;
  const viewportRect = container?.getBoundingClientRect() ?? null;
  const activeDraft = drafts.find((draft) => draft.id === editorId) ?? null;
  const savedDrafts = drafts.filter((draft) => draft.savedNote.trim());
  useEffect(() => {
    const update = () => setVersion((current) => current + 1);
    const viewport = containerRef.current;
    viewport?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [containerRef]);

  if (!outer || !container || !viewportRect) return null;
  const clippedRect = (rect: DOMRect): { top: number; left: number; width: number; height: number } | null => {
    const left = Math.max(rect.left, viewportRect.left);
    const top = Math.max(rect.top, viewportRect.top);
    const right = Math.min(rect.right, viewportRect.right);
    const bottom = Math.min(rect.bottom, viewportRect.bottom);
    return right > left && bottom > top ? { top, left, width: right - left, height: bottom - top } : null;
  };
  const allRanges = [
    ...drafts.map((draft) => ({ key: `draft-${draft.id}`, source: draft.source, className: draft.id === editorId ? "bg-primary/25 ring-1 ring-primary/40" : "bg-primary/15" })),
  ];
  const badges = savedDrafts.reduce<Array<{ draft: PrototypeDraft; top: number; left: number; displayNumber: number }>>((result, draft) => {
    const source = findSourceElement(draft.source);
    if (!source) return result;
    const rects = rangeRects(draft.source);
    const visibleRects = rects.filter((range) => (
      range.right > viewportRect.left && range.left < viewportRect.right &&
      range.bottom > viewportRect.top && range.top < viewportRect.bottom
    ));
    const rect = visibleRects[visibleRects.length - 1];
    if (!rect) return result;
    const markerSize = 32;
    const minTop = viewportRect.top - outer.top + 4;
    const maxTop = Math.max(minTop, viewportRect.bottom - outer.top - markerSize - 52);
    const minLeft = viewportRect.left - outer.left + 4;
    const maxLeft = Math.max(minLeft, viewportRect.right - outer.left - markerSize - 4);
    const markerLeft = clampPosition(rect.right - outer.left - markerSize / 2, minLeft, maxLeft);
    const baseTop = clampPosition(rect.top - outer.top + Math.min(rect.height / 2, 16) - markerSize / 2, minTop, maxTop);
    const overlaps = (top: number) => result.some((item) => (
      Math.abs(item.left - markerLeft) < markerSize && Math.abs(item.top - top) < markerSize
    ));
    let markerTop = baseTop;
    for (let offsetIndex = 1; overlaps(markerTop) && offsetIndex <= result.length * 2 + 1; offsetIndex += 1) {
      const distance = Math.ceil(offsetIndex / 2) * 24;
      const direction = offsetIndex % 2 === 1 ? 1 : -1;
      const candidate = clampPosition(baseTop + direction * distance, minTop, maxTop);
      if (!overlaps(candidate)) markerTop = candidate;
    }
    const threadSavedDrafts = savedDrafts.filter((item) => item.source.threadId === draft.source.threadId);
    result.push({
      draft,
      top: markerTop,
      left: markerLeft,
      displayNumber: threadSavedDrafts.findIndex((item) => item.id === draft.id) + 1,
    });
    return result;
  }, []);
  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-20" aria-hidden="true" data-prototype-highlight-layer={version}>
        {allRanges.flatMap(({ key, source, className }) => rangeRects(source).flatMap((rect, index) => {
          const clipped = clippedRect(rect);
          return clipped ? [
            <div
              key={`${key}-${index}`}
              className={cn("absolute rounded-sm", className)}
              style={{ top: clipped.top - outer.top, left: clipped.left - outer.left, width: clipped.width, height: clipped.height }}
            />,
          ] : [];
        }))}
      </div>
      {badges.map(({ draft, top, left, displayNumber }) => (
        <Tooltip key={draft.id}>
          <TooltipTrigger
            render={
              <Button
                type="button"
                data-testid="selected-text-comment-marker"
                variant="ghost"
                size="icon-sm"
                className="group/marker absolute z-30 flex size-8 items-center justify-center rounded-full bg-transparent p-0 hover:bg-transparent focus-visible:bg-transparent"
                style={{ top, left }}
                aria-label={`Open comment ${displayNumber}`}
                onClick={() => useSelectedTextPrototypeStore.getState().openDraft(draft.id)}
              >
                <NumberedCommentIcon className="size-7 drop-shadow-sm transition-transform duration-150 group-hover/marker:scale-105 group-focus-visible/marker:scale-105" displayNumber={displayNumber} />
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={8} className="max-w-64 rounded-lg px-3 py-2 text-xs leading-snug shadow-xl">
            {draft.savedNote}
          </TooltipContent>
        </Tooltip>
      ))}
      {activeDraft && <DraftEditor draft={activeDraft} containerRef={containerRef} />}
    </>
  );
}

/** Dev-only selected-text comments interaction layer for the real message list. */
export function SelectedTextCommentsPrototype({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const menu = useSelectedTextPrototypeStore((state) => state.menu);
  const setMenu = useSelectedTextPrototypeStore((state) => state.setMenu);
  const editorId = useSelectedTextPrototypeStore((state) => state.editorId);
  const drafts = useSelectedTextPrototypeStore((state) => state.drafts);
  const setWarningMethod = useSelectedTextPrototypeStore((state) => state.setWarningMethod);
  const deleteDraft = useSelectedTextPrototypeStore((state) => state.deleteDraft);
  const closeEditor = useSelectedTextPrototypeStore((state) => state.closeEditor);
  const menuOriginRef = useRef<HTMLElement | null>(null);
  const menuWasOpenRef = useRef(false);
  const restoreMenuOrigin = useCallback(() => {
    const origin = menuOriginRef.current;
    menuOriginRef.current = null;
    if (origin?.isConnected) origin.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (menuWasOpenRef.current && !menu && !editorId) restoreMenuOrigin();
    menuWasOpenRef.current = !!menu;
  }, [editorId, menu, restoreMenuOrigin]);

  useEffect(() => {
    const openMenu = (
      event: Pick<MouseEvent, "clientX" | "clientY">,
      source: SelectedTextSource,
      target: Element | null,
    ) => {
      menuOriginRef.current = target?.closest<HTMLElement>("[tabindex]") ?? null;
      setMenu({
        x: clampPosition(event.clientX, 8, Math.max(8, window.innerWidth - 8)),
        y: clampPosition(event.clientY, 8, Math.max(8, window.innerHeight - 8)),
        source,
      });
    };
    const handleContextMenu = (event: MouseEvent) => {
      const root = sourceRootFromTarget(event.target as Element | null);
      if (!root) return;
      const selection = window.getSelection();
      const source = selection ? sourceFromSelection(root, selection) : null;
      if (!source) return;
      event.preventDefault();
      openMenu(event, source, event.target as Element | null);
    };
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (!editorId || (event.target as Element | null)?.closest("[data-prototype-editor], [role=menu]")) return;
      const draft = drafts.find((item) => item.id === editorId);
      if (!draft) return;
      if (draft.note !== draft.savedNote) {
        const state = useSelectedTextPrototypeStore.getState();
        if (state.warningMethod === "outside") deleteDraft(draft.id);
        else setWarningMethod("outside");
      } else {
        closeEditor();
      }
    };
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
    };
  }, [closeEditor, deleteDraft, drafts, editorId, setMenu, setWarningMethod]);

  return (
    <>
      <PrototypeOverlay containerRef={containerRef} />
      <PrototypeContextMenu />
    </>
  );
}

/** In-memory saved comment chips rendered in the real composer surface. */
export function SelectedTextCommentsComposerCards({ threadId }: { threadId?: string }) {
  const drafts = useSelectedTextPrototypeStore((state) => state.drafts);
  const deleteDraft = useSelectedTextPrototypeStore((state) => state.deleteDraft);
  const [, refreshAvailability] = useState(0);
  useEffect(() => {
    const refresh = () => refreshAvailability((value) => value + 1);
    let viewport: HTMLElement | null = null;
    let removeScrollListener: (() => void) | null = null;
    const bindViewport = () => {
      const nextViewport = document.querySelector<HTMLElement>("[data-testid=message-list] > div");
      if (nextViewport === viewport) {
        refresh();
        return;
      }
      removeScrollListener?.();
      viewport = nextViewport;
      if (viewport) {
        const boundViewport = viewport;
        boundViewport.addEventListener("scroll", refresh, { passive: true });
        removeScrollListener = () => boundViewport.removeEventListener("scroll", refresh);
      } else {
        removeScrollListener = null;
      }
      refresh();
    };
    bindViewport();
    const chatRoot = document.querySelector<HTMLElement>("[data-testid=chat-view]");
    const observerRoot = chatRoot ?? document.body;
    const observer = new MutationObserver(bindViewport);
    observer.observe(observerRoot, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      removeScrollListener?.();
    };
  }, [threadId]);
  const savedDrafts = drafts.filter((draft) => draft.savedNote.trim());
  const visibleDrafts = savedDrafts.filter((draft) => !threadId || draft.source.threadId === threadId);
  if (!isSelectedTextCommentsPrototypeEnabled() || visibleDrafts.length === 0) return null;
  const commentLabel = `${visibleDrafts.length} comment${visibleDrafts.length === 1 ? "" : "s"}`;
  return (
    <div className="px-3 pt-2" data-testid="selected-text-comment-cards">
      <div className="inline-flex h-8 max-w-full items-center overflow-hidden rounded-lg border border-border bg-background focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`${commentLabel}. Details available.`}
                className="min-w-0 rounded-none border-y-0 border-l-0 border-r border-border bg-transparent px-3 text-foreground hover:bg-muted focus-visible:z-10"
              >
                <MessageCircle size={16} aria-hidden />
                <span className="min-w-0 truncate">{commentLabel}</span>
              </Button>
            }
          />
          <TooltipContent
            variant="surface"
            side="top"
            align="end"
            sideOffset={8}
            className="w-[min(28rem,calc(100vw-1.6rem))] max-w-none items-stretch rounded-xl p-0"
          >
            <ol className="max-h-80 min-w-0 list-none overflow-y-auto p-1">
              {visibleDrafts.map((draft, index) => (
                <li key={draft.id} className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-2 border-b border-border/45 px-2 py-2 last:border-b-0">
                  <span className="font-mono text-xs leading-5 tabular-nums text-muted-foreground" aria-hidden>
                    {index + 1}
                  </span>
                  <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-5">
                    {draft.savedNote}
                  </p>
                </li>
              ))}
            </ol>
          </TooltipContent>
        </Tooltip>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${commentLabel}`}
          onClick={() => visibleDrafts.forEach((draft) => deleteDraft(draft.id))}
          className="rounded-none border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:z-10"
        >
          <X size={16} aria-hidden />
        </Button>
      </div>
    </div>
  );
}
