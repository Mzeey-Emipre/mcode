import { MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS } from "@mcode/contracts";

/** Canonical visible prose-and-code text for one eligible Message. */
export interface CanonicalMessageTextProjection {
  /** Text measured in UTF-16 code units. */
  text: string;
}

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

interface ProjectionState extends CanonicalMessageTextProjection {
  segments: TextSegment[];
}

/** Immutable message identity and range captured from a native pointer selection. */
export interface SelectedTextCommentSource {
  /** Owning conversation thread. */
  threadId: string;
  /** Source Message identity. */
  messageId: string;
  /** Source Message role. */
  sourceRole: "user" | "assistant";
  /** Inclusive UTF-16 start offset into the canonical projection. */
  start: number;
  /** Exclusive UTF-16 end offset into the canonical projection. */
  end: number;
  /** Exact selected prose or code. */
  quote: string;
}

const BLOCK_ELEMENTS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIELDSET",
  "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "UL",
]);

const EXCLUDED_CONTENT_SELECTOR = [
  "[data-selected-text-exclude]",
  "[aria-hidden='true']",
  "[hidden]",
  ".sr-only",
  "script",
  "style",
  "template",
].join(", ");

function isExcluded(node: Element): boolean {
  return node.matches(EXCLUDED_CONTENT_SELECTOR);
}

function rangeIntersectsExcludedContent(root: HTMLElement, range: Range): boolean {
  if (isExcluded(root)) return true;
  return [...root.querySelectorAll(EXCLUDED_CONTENT_SELECTOR)].some((node) => range.intersectsNode(node));
}

function buildProjection(root: HTMLElement): ProjectionState {
  let text = "";
  const segments: TextSegment[] = [];

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      if (value.length === 0) return;
      const start = text.length;
      text += value;
      segments.push({ node: node as Text, start, end: text.length });
      return;
    }

    if (!(node instanceof Element) || isExcluded(node)) return;
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }

    for (const child of node.childNodes) visit(child);
    if (BLOCK_ELEMENTS.has(node.tagName)) text += "\n";
  };

  for (const child of root.childNodes) visit(child);
  return { text, segments };
}

function rangeBoundary(
  segments: readonly TextSegment[],
  offset: number,
  isStart: boolean,
): { node: Text; offset: number } | null {
  const matching = isStart
    ? segments.find((segment) => offset >= segment.start && offset < segment.end)
    : [...segments].reverse().find((segment) => offset > segment.start && offset <= segment.end);
  if (!matching) return null;
  return { node: matching.node, offset: offset - matching.start };
}

function contentElement(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const content = element?.closest<HTMLElement>("[data-selected-text-content]");
  return content ?? null;
}

function segmentForNode(
  segments: readonly TextSegment[],
  node: Node,
): TextSegment | undefined {
  return segments.find((segment) => segment.node === node);
}

function firstSegmentInNode(
  segments: readonly TextSegment[],
  node: Node,
): TextSegment | undefined {
  return segments.find((segment) => node.contains(segment.node));
}

function lastSegmentInNode(
  segments: readonly TextSegment[],
  node: Node,
): TextSegment | undefined {
  return [...segments].reverse().find((segment) => node.contains(segment.node));
}

function projectionOffsetForPoint(
  root: HTMLElement,
  segments: readonly TextSegment[],
  container: Node,
  offset: number,
): number | null {
  if (!Number.isInteger(offset) || offset < 0 || !root.contains(container)) return null;
  return container.nodeType === Node.TEXT_NODE
    ? textNodeProjectionOffset(segments, container, offset)
    : elementProjectionOffset(segments, container, offset);
}

function textNodeProjectionOffset(
  segments: readonly TextSegment[],
  container: Node,
  offset: number,
): number | null {
  const segment = segmentForNode(segments, container);
  const length = container.textContent?.length ?? 0;
  return segment && offset <= length ? segment.start + offset : null;
}

function elementProjectionOffset(
  segments: readonly TextSegment[],
  container: Node,
  offset: number,
): number | null {
  if (offset > container.childNodes.length) return null;
  const following = offset < container.childNodes.length
    ? firstSegmentInNode(segments, container.childNodes[offset])
    : undefined;
  if (following) return following.start;
  const previous = offset > 0
    ? lastSegmentInNode(segments, container.childNodes[offset - 1])
    : undefined;
  return previous?.end ?? null;
}

function selectedTextRoot(
  selection: Selection,
  contextMenuTarget: EventTarget | null,
): { root: HTMLElement; range: Range } | null {
  if (selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const root = contentElement(range.startContainer);
  const endRoot = contentElement(range.endContainer);
  const targetRoot = contextMenuTarget instanceof Node ? contentElement(contextMenuTarget) : null;
  return root && root === endRoot && root === targetRoot && root.dataset.selectedTextEligible === "true"
    ? { root, range }
    : null;
}

function selectedTextMessage(root: HTMLElement): Pick<SelectedTextCommentSource, "threadId" | "messageId" | "sourceRole"> | null {
  const message = root.closest<HTMLElement>("[data-message-id][data-message-role][data-thread-id]");
  const messageId = message?.dataset.messageId;
  const threadId = message?.dataset.threadId;
  const sourceRole = message?.dataset.messageRole;
  return messageId && threadId && (sourceRole === "user" || sourceRole === "assistant")
    ? { threadId, messageId, sourceRole }
    : null;
}

function selectedTextRange(projection: ProjectionState, root: HTMLElement, range: Range): { start: number; end: number; quote: string } | null {
  const start = projectionOffsetForPoint(root, projection.segments, range.startContainer, range.startOffset);
  const end = projectionOffsetForPoint(root, projection.segments, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  const quote = projection.text.slice(start, end);
  return quote.trim() && quote.length <= MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS ? { start, end, quote } : null;
}

/** Builds the canonical visible prose-and-code projection for one Message. */
export function createCanonicalMessageTextProjection(root: HTMLElement): CanonicalMessageTextProjection {
  const projection = buildProjection(root);
  return { text: projection.text };
}

/** Reads an exact eligible Message selection made at a native context-menu target. */
export function createSelectedTextCommentSource(
  selection: Selection,
  contextMenuTarget: EventTarget | null,
): SelectedTextCommentSource | null {
  const selectedRoot = selectedTextRoot(selection, contextMenuTarget);
  if (!selectedRoot || rangeIntersectsExcludedContent(selectedRoot.root, selectedRoot.range)) return null;
  const message = selectedTextMessage(selectedRoot.root);
  if (!message) return null;
  const selectedRange = selectedTextRange(buildProjection(selectedRoot.root), selectedRoot.root, selectedRoot.range);
  return selectedRange ? { ...message, ...selectedRange } : null;
}

/** Reconstructs an exact stored range from canonical UTF-16 offsets without quote searching. */
export function reconstructCanonicalMessageRange(
  root: HTMLElement,
  start: number,
  end: number,
  quote: string,
): Range | null {
  const projection = buildProjection(root);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end <= start
    || projection.text.slice(start, end) !== quote
  ) return null;

  const rangeStart = rangeBoundary(projection.segments, start, true);
  const rangeEnd = rangeBoundary(projection.segments, end, false);
  if (!rangeStart || !rangeEnd) return null;

  const range = root.ownerDocument.createRange();
  range.setStart(rangeStart.node, rangeStart.offset);
  range.setEnd(rangeEnd.node, rangeEnd.offset);
  return range;
}

/** Finds the rendered content element for one canonical selected-text source. */
export function findSelectedTextCommentContent(
  source: SelectedTextCommentSource,
  viewport: Element,
  renderedThreadId: string | null | undefined,
): HTMLElement | null {
  if (source.threadId !== renderedThreadId) return null;
  return [...viewport.querySelectorAll<HTMLElement>("[data-selected-text-content]")].find((content) => {
    const message = content.closest<HTMLElement>("[data-message-id][data-message-role][data-thread-id]");
    return content.dataset.selectedTextEligible === "true"
      && message?.dataset.messageId === source.messageId
      && message.dataset.messageRole === source.sourceRole
      && message.dataset.threadId === source.threadId;
  }) ?? null;
}

/** Returns the last selected range rectangle that intersects the message viewport. */
export function lastVisibleRangeRect(range: Range, viewport: Element): DOMRect | null {
  const viewportRect = viewport.getBoundingClientRect();
  return [...range.getClientRects()].reverse().find((rect) => (
    rect.right > viewportRect.left
    && rect.left < viewportRect.right
    && rect.bottom > viewportRect.top
    && rect.top < viewportRect.bottom
  )) ?? null;
}
