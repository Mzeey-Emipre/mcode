import {
  BROWSER_AUTOMATION_MAX_ELEMENTS,
  BROWSER_AUTOMATION_MAX_RESULT_BYTES,
  BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH,
  BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS,
} from "@mcode/contracts";

type BrowserAutomationScreenshot = {
  readonly mediaType: "image/png";
  readonly dataBase64: string;
  readonly width: number;
  readonly height: number;
  readonly truncation: { readonly truncated: false } | { readonly truncated: true; readonly originalCount: number; readonly reason: "entry-limit" };
};
type BrowserAutomationElement = {
  readonly semanticId: string;
  readonly role: string;
  readonly accessibleName: string;
  readonly value?: string;
  readonly disabled: boolean;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
};
type BrowserAutomationSnapshot = {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly visibleText: string;
  readonly visibleTextTruncation: { readonly truncated: false } | { readonly truncated: true; readonly originalCount: number; readonly reason: "character-limit" };
  readonly elements: BrowserAutomationElement[];
  readonly elementsTruncation: { readonly truncated: false } | { readonly truncated: true; readonly originalCount: number; readonly reason: "entry-limit" };
  readonly accessibility: never[];
  readonly accessibilityTruncation: { readonly truncated: false };
  readonly console: never[];
  readonly consoleTruncation: { readonly truncated: false };
  readonly network: never[];
  readonly networkTruncation: { readonly truncated: false };
  readonly actions: never[];
  readonly actionsTruncation: { readonly truncated: false };
  readonly screenshot?: BrowserAutomationScreenshot;
};

const MAX_DOM_NODES = 1_000;
const MAX_SOURCE_CHILDREN = 16_000;
const MAX_CANVAS_AREA = 8_000_000;
const MAX_TEXT_PER_NODE = 1_024;
const MAX_ATTRIBUTE_CHARS = 2_048;
const MAX_ATTRIBUTE_COUNT = 4_000;
const MAX_ATTRIBUTE_BYTES = 128 * 1_024;
const MAX_STYLE_PROPERTIES = 16_000;
const MAX_STYLE_BYTES = 512 * 1_024;
const MAX_SERIALIZED_BYTES = 256 * 1_024;
const MAX_CAPTURE_DATA_BYTES = BROWSER_AUTOMATION_MAX_RESULT_BYTES - 8_192;
const SECRET_NAME = /(pass(word)?|token|secret|api[_-]?key|auth|credential|session|cookie|jwt|bearer)/i;
const SECRET_VALUE = /(?:bearer\s+)?(?:eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9._-]{8,}|[A-Za-z0-9_+/=-]{32,})/g;
const SECRET_SHAPED = /(?:bearer\s+)?(?:eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9._-]{8,}|[A-Za-z0-9_+/=-]{32,})/;
const SKIP_TAGS = new Set(["script", "style", "template", "iframe", "object", "embed", "noscript"]);
const RESOURCE_ATTRIBUTES = new Set(["src", "srcset", "href", "poster", "action", "formaction", "background"]);
const INTERACTIVE_TAGS = new Set(["button", "a", "input", "textarea", "select"]);

/** Stable low-level capture failure returned by the web mechanics layer. */
export type WebCaptureFailureCode = "CROSS_ORIGIN" | "TIMEOUT" | "OPERATION_CANCELLED" | "RESULT_TOO_LARGE" | "INTERNAL_ERROR";

/** Structured result from one bounded web capture mechanic. */
export type WebCaptureResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: WebCaptureFailureCode };

/** Explicit inputs required to capture one visible same-origin iframe. */
export interface WebCaptureInput {
  readonly iframe: HTMLIFrameElement;
  readonly maxWidth: number;
  readonly deadline: number;
  readonly signal?: AbortSignal;
}

interface StyleBudget {
  properties: number;
  bytes: number;
}

interface CloneBudget {
  attributeCount: number;
  attributeBytes: number;
  readonly style: StyleBudget;
}

interface CloneQueueEntry {
  readonly source: Node;
  readonly clone: Node;
  readonly sensitive: boolean;
}

interface CloneTraversalState {
  count: number;
  originalCount: number;
  truncated: boolean;
  visitedSourceChildren: number;
}

interface VisibleTextState {
  text: string;
  originalCount: number;
  truncated: boolean;
}

interface ElementCollectionState {
  readonly items: BrowserAutomationElement[];
  interactiveCount: number;
  originalCount: number;
  truncated: boolean;
}

function failure(code: WebCaptureFailureCode): WebCaptureResult<never> { return { ok: false, code }; }

function cancelledOrTimedOut(input: Pick<WebCaptureInput, "deadline" | "signal">): WebCaptureFailureCode | null {
  if (input.signal?.aborted) return "OPERATION_CANCELLED";
  return Date.now() >= input.deadline ? "TIMEOUT" : null;
}

function sanitizeText(value: string, max = MAX_TEXT_PER_NODE): string {
  return value.replace(SECRET_VALUE, "[redacted]").slice(0, max);
}

function isSensitiveElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea" || isPasswordInput(element, tag)) return true;
  return hasSensitiveAttribute(element);
}

function isPasswordInput(element: Element, tag: string): boolean {
  return tag === "input" && (element.getAttribute("type") ?? "").toLowerCase() === "password";
}

function hasSensitiveAttribute(element: Element): boolean {
  for (let index = 0; index < Math.min(element.attributes.length, MAX_ATTRIBUTE_COUNT); index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute && (SECRET_NAME.test(attribute.name) || SECRET_NAME.test(attribute.value))) return true;
  }
  return false;
}

function isVisibleElement(document: Document, element: Element): boolean {
  if (isHiddenElement(element)) return false;
  const style = computedStyle(document, element);
  return style !== null && (!style || !isConcealedStyle(style));
}

function isHiddenElement(element: Element): boolean {
  return SKIP_TAGS.has(element.tagName.toLowerCase()) ||
    element.hasAttribute("hidden") ||
    element.hasAttribute("inert") ||
    element.getAttribute("aria-hidden") === "true";
}

function computedStyle(document: Document, element: Element): CSSStyleDeclaration | null | undefined {
  try {
    return document.defaultView?.getComputedStyle(element);
  } catch {
    return null;
  }
}

function isConcealedStyle(style: CSSStyleDeclaration): boolean {
  return style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    style.contentVisibility === "hidden" ||
    style.opacity === "0";
}

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }

function copyComputedStyle(document: Document, source: Element, clone: HTMLElement, budget: StyleBudget): WebCaptureResult<void> {
  const style = computedStyle(document, source);
  if (style === null) return failure("INTERNAL_ERROR");
  if (!style) return { ok: true, value: undefined };
  const declarations = collectStyleDeclarations(style, budget);
  if (!declarations.ok) return declarations;
  if (declarations.value.length > 0) clone.setAttribute("style", declarations.value.join(""));
  return { ok: true, value: undefined };
}

function collectStyleDeclarations(style: CSSStyleDeclaration, budget: StyleBudget): WebCaptureResult<string[]> {
  if (style.length > MAX_STYLE_PROPERTIES) return failure("RESULT_TOO_LARGE");
  const declarations: string[] = [];
  for (let index = 0; index < style.length; index += 1) {
    const declaration = styleDeclaration(style.item(index), style.getPropertyValue(style.item(index)), budget);
    if (!declaration.ok) return declaration;
    if (declaration.value) declarations.push(declaration.value);
  }
  return { ok: true, value: declarations };
}

function styleDeclaration(property: string, value: string, budget: StyleBudget): WebCaptureResult<string | null> {
  if (!property || !value || property.startsWith("--") || property === "content" || /url\s*\(/i.test(value)) {
    return { ok: true, value: null };
  }
  if (budget.properties >= MAX_STYLE_PROPERTIES) return failure("RESULT_TOO_LARGE");
  const declaration = `${property}:${value};`;
  const bytes = utf8Bytes(declaration);
  if (budget.bytes + bytes > MAX_STYLE_BYTES) return failure("RESULT_TOO_LARGE");
  budget.properties += 1;
  budget.bytes += bytes;
  return { ok: true, value: declaration };
}

function cloneBoundedDocument(
  document: Document,
  input: Pick<WebCaptureInput, "deadline" | "signal">,
): WebCaptureResult<{ readonly root: HTMLElement; readonly truncated: boolean; readonly originalCount: number; readonly serialized: string }> {
  const source = document.body ?? document.documentElement;
  const root = source.cloneNode(false) as HTMLElement;
  const budget: CloneBudget = { attributeCount: 0, attributeBytes: 0, style: { properties: 0, bytes: 0 } };
  const rootResult = prepareCloneRoot(document, source, root, budget);
  if (!rootResult.ok) return rootResult;
  const state: CloneTraversalState = { count: 1, originalCount: 1, truncated: false, visitedSourceChildren: 0 };
  const queue: CloneQueueEntry[] = [{ source, clone: root, sensitive: false }];
  const traversal = cloneDocumentNodes(document, input, queue, state, budget);
  if (!traversal.ok) return traversal;
  return serializeClone(root, state);
}

function prepareCloneRoot(document: Document, source: Element, root: HTMLElement, budget: CloneBudget): WebCaptureResult<void> {
  removeAttributes(root);
  const attributes = copyElementAttributes(source, root, budget);
  if (!attributes.ok) return attributes;
  return copyComputedStyle(document, source, root, budget.style);
}

function removeAttributes(element: HTMLElement): void {
  for (let index = element.attributes.length - 1; index >= 0; index -= 1) {
    element.removeAttribute(element.attributes.item(index)!.name);
  }
}

function copyElementAttributes(source: Element, clone: HTMLElement, budget: CloneBudget): WebCaptureResult<void> {
  for (let index = 0; index < source.attributes.length; index += 1) {
    const copied = copyElementAttribute(source.attributes.item(index)!, clone, budget);
    if (!copied.ok) return copied;
  }
  return { ok: true, value: undefined };
}

function copyElementAttribute(attribute: Attr, clone: HTMLElement, budget: CloneBudget): WebCaptureResult<void> {
  budget.attributeCount += 1;
  budget.attributeBytes += utf8Bytes(attribute.name) + utf8Bytes(attribute.value);
  if (budget.attributeCount > MAX_ATTRIBUTE_COUNT || budget.attributeBytes > MAX_ATTRIBUTE_BYTES) {
    return failure("RESULT_TOO_LARGE");
  }
  if (isUnsafeAttribute(attribute.name)) return { ok: true, value: undefined };
  clone.setAttribute(attribute.name, isSensitiveAttribute(attribute) ? "[redacted]" : sanitizeText(attribute.value, MAX_ATTRIBUTE_CHARS));
  return { ok: true, value: undefined };
}

function isUnsafeAttribute(name: string): boolean {
  const normalized = name.toLowerCase();
  return RESOURCE_ATTRIBUTES.has(normalized) || normalized.startsWith("on");
}

function isSensitiveAttribute(attribute: Attr): boolean {
  return SECRET_NAME.test(attribute.name) || SECRET_SHAPED.test(attribute.value);
}

function cloneDocumentNodes(
  document: Document,
  input: Pick<WebCaptureInput, "deadline" | "signal">,
  queue: CloneQueueEntry[],
  state: CloneTraversalState,
  budget: CloneBudget,
): WebCaptureResult<void> {
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const children = cloneSourceChildren(document, input, queue[cursor]!, queue, state, budget);
    if (!children.ok) return children;
  }
  return { ok: true, value: undefined };
}

function cloneSourceChildren(
  document: Document,
  input: Pick<WebCaptureInput, "deadline" | "signal">,
  current: CloneQueueEntry,
  queue: CloneQueueEntry[],
  state: CloneTraversalState,
  budget: CloneBudget,
): WebCaptureResult<void> {
  for (let child = current.source.firstChild; child; child = child.nextSibling) {
    const traversal = advanceCloneTraversal(input, state);
    if (!traversal.ok) return traversal;
    if (state.count >= MAX_DOM_NODES) {
      state.truncated = true;
      state.originalCount = MAX_DOM_NODES + 1;
      return { ok: true, value: undefined };
    }
    state.originalCount += 1;
    const appended = appendClonedChild(document, current, child, queue, state, budget);
    if (!appended.ok) return appended;
  }
  return { ok: true, value: undefined };
}

function advanceCloneTraversal(
  input: Pick<WebCaptureInput, "deadline" | "signal">,
  state: CloneTraversalState,
): WebCaptureResult<void> {
  state.visitedSourceChildren += 1;
  if (state.visitedSourceChildren > MAX_SOURCE_CHILDREN) return failure("RESULT_TOO_LARGE");
  if (state.visitedSourceChildren % 32 !== 0) return { ok: true, value: undefined };
  const stop = cancelledOrTimedOut(input);
  return stop ? failure(stop) : { ok: true, value: undefined };
}

function appendClonedChild(
  document: Document,
  current: CloneQueueEntry,
  child: Node,
  queue: CloneQueueEntry[],
  state: CloneTraversalState,
  budget: CloneBudget,
): WebCaptureResult<void> {
  if (child.nodeType === Node.TEXT_NODE) return appendClonedText(document, current, child, state);
  if (child.nodeType !== Node.ELEMENT_NODE) return { ok: true, value: undefined };
  return appendClonedElement(document, current, child as Element, queue, state, budget);
}

function appendClonedText(
  document: Document,
  current: CloneQueueEntry,
  child: Node,
  state: CloneTraversalState,
): WebCaptureResult<void> {
  if (current.sensitive) return { ok: true, value: undefined };
  current.clone.appendChild(document.createTextNode(sanitizeText(child.textContent ?? "")));
  state.count += 1;
  return { ok: true, value: undefined };
}

function appendClonedElement(
  document: Document,
  current: CloneQueueEntry,
  element: Element,
  queue: CloneQueueEntry[],
  state: CloneTraversalState,
  budget: CloneBudget,
): WebCaptureResult<void> {
  if (!isVisibleElement(document, element)) return { ok: true, value: undefined };
  const sensitive = current.sensitive || isSensitiveElement(element);
  const cloned = element.cloneNode(false) as HTMLElement;
  const attributes = copyElementAttributes(element, cloned, budget);
  if (!attributes.ok) return attributes;
  const styled = copyComputedStyle(document, element, cloned, budget.style);
  if (!styled.ok) return styled;
  maskClonedElement(cloned, element.tagName.toLowerCase(), sensitive);
  current.clone.appendChild(cloned);
  if (!sensitive) queue.push({ source: element, clone: cloned, sensitive: false });
  state.count += 1;
  return { ok: true, value: undefined };
}

function maskClonedElement(cloned: HTMLElement, tag: string, sensitive: boolean): void {
  if (sensitive) {
    cloned.textContent = "[redacted]";
    cloned.setAttribute("value", "");
    return;
  }
  if (tag === "input" || tag === "textarea" || tag === "select") {
    cloned.textContent = "";
    cloned.setAttribute("value", "");
  }
}

function serializeClone(
  root: HTMLElement,
  state: CloneTraversalState,
): WebCaptureResult<{ readonly root: HTMLElement; readonly truncated: boolean; readonly originalCount: number; readonly serialized: string }> {
  const serialized = serializeRoot(root);
  if (!serialized.ok) return serialized;
  if (utf8Bytes(serialized.value) > MAX_SERIALIZED_BYTES) return failure("RESULT_TOO_LARGE");
  return { ok: true, value: { root, truncated: state.truncated, originalCount: state.originalCount, serialized: serialized.value } };
}

function serializeRoot(root: HTMLElement): WebCaptureResult<string> {
  try {
    return { ok: true, value: new XMLSerializer().serializeToString(root) };
  } catch {
    return failure("INTERNAL_ERROR");
  }
}

function sameOrigin(iframe: HTMLIFrameElement): WebCaptureResult<Document> {
  try {
    const frameWindow = iframe.contentWindow;
    const document = iframe.contentDocument;
    if (!frameWindow || !document || frameWindow.location.origin !== window.location.origin) return failure("CROSS_ORIGIN");
    void document.body;
    return { ok: true, value: document };
  } catch {
    return failure("CROSS_ORIGIN");
  }
}

async function waitForImage(
  image: HTMLImageElement,
  source: string,
  input: Pick<WebCaptureInput, "deadline" | "signal">,
): Promise<WebCaptureResult<void>> {
  const stop = cancelledOrTimedOut(input);
  if (stop) return failure(stop);
  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const onAbort = (): void => finish(failure("OPERATION_CANCELLED"));
    const finish = (result: WebCaptureResult<void>): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    timer = window.setTimeout(() => finish(failure("TIMEOUT")), Math.max(1, input.deadline - Date.now()));
    image.onload = () => finish({ ok: true, value: undefined });
    image.onerror = () => finish(failure("INTERNAL_ERROR"));
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      image.src = source;
    } catch {
      finish(failure("INTERNAL_ERROR"));
    }
  });
}

function encodedBytes(dataBase64: string): number { return Math.floor(dataBase64.length * 3 / 4); }

/** Capture a bounded, redacted PNG of the iframe's visible viewport. */
export async function captureVisibleWebScreenshot(input: WebCaptureInput): Promise<WebCaptureResult<BrowserAutomationScreenshot>> {
  const origin = sameOrigin(input.iframe);
  if (!origin.ok) return origin;
  const stop = cancelledOrTimedOut(input);
  if (stop) return failure(stop);
  const dimensions = screenshotDimensions(input);
  const clone = cloneBoundedDocument(origin.value, input);
  if (!clone.ok) return clone;
  const source = svgCaptureSource(clone.value.serialized, dimensions.width, dimensions.height);
  if (!source.ok) return source;
  const image = new Image();
  const loaded = await waitForImage(image, source.value, input);
  if (!loaded.ok) return loaded;
  const rendered = renderPng(origin.value, image, dimensions, input);
  if (!rendered.ok) return rendered;
  return {
    ok: true,
    value: {
      mediaType: "image/png",
      dataBase64: rendered.value.dataBase64,
      width: rendered.value.width,
      height: rendered.value.height,
      truncation: screenshotTruncation(clone.value, dimensions.width, rendered.value.width),
    },
  };
}

function screenshotDimensions(input: WebCaptureInput): { readonly width: number; readonly height: number } {
  const width = Math.max(
    1,
    Math.min(BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH, Math.floor(input.maxWidth), input.iframe.clientWidth || BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH),
  );
  const height = Math.max(1, Math.min(10_000, input.iframe.clientHeight || 720, Math.floor(MAX_CANVAS_AREA / width)));
  return { width, height };
}

function svgCaptureSource(serialized: string, width: number, height: number): WebCaptureResult<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
  if (utf8Bytes(svg) > MAX_SERIALIZED_BYTES) return failure("RESULT_TOO_LARGE");
  return { ok: true, value: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
}

function renderPng(
  document: Document,
  image: HTMLImageElement,
  dimensions: { readonly width: number; readonly height: number },
  input: Pick<WebCaptureInput, "deadline" | "signal">,
): WebCaptureResult<{ readonly dataBase64: string; readonly width: number; readonly height: number }> {
  const canvas = document.createElement("canvas");
  let width = dimensions.width;
  let height = dimensions.height;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const stop = cancelledOrTimedOut(input);
    if (stop) return failure(stop);
    const encoded = drawPng(canvas, image, width, height);
    if (!encoded.ok) return encoded;
    const dataBase64 = pngDataBase64(encoded.value);
    if (!dataBase64.ok) return dataBase64;
    if (encodedBytes(dataBase64.value) <= MAX_CAPTURE_DATA_BYTES) {
      return { ok: true, value: { dataBase64: dataBase64.value, width, height } };
    }
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
  return failure("RESULT_TOO_LARGE");
}

function drawPng(canvas: HTMLCanvasElement, image: HTMLImageElement, width: number, height: number): WebCaptureResult<string> {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return failure("INTERNAL_ERROR");
  try {
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return { ok: true, value: canvas.toDataURL("image/png") };
  } catch {
    return failure("CROSS_ORIGIN");
  }
}

function pngDataBase64(encoded: string): WebCaptureResult<string> {
  const prefix = "data:image/png;base64,";
  if (!encoded.startsWith(prefix)) return failure("INTERNAL_ERROR");
  return { ok: true, value: encoded.slice(prefix.length) };
}

function screenshotTruncation(
  clone: { readonly truncated: boolean; readonly originalCount: number },
  requestedWidth: number,
  finalWidth: number,
): BrowserAutomationScreenshot["truncation"] {
  if (!clone.truncated && finalWidth === requestedWidth) return { truncated: false };
  return {
    truncated: true,
    originalCount: Math.max(finalWidth + 1, finalWidth < requestedWidth ? requestedWidth : 0, clone.truncated ? clone.originalCount : 0),
    reason: "entry-limit",
  };
}

/** Remove credentials, query, fragment, and token-shaped path segments from a URL. */
export function sanitizeWebLocation(value: string): string {
  try {
    const parsed = new URL(value, window.location.href);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = redactedPathname(parsed.pathname);
    return parsed.toString();
  } catch {
    return "about:blank";
  }
}

function redactedPathname(pathname: string): string {
  let redactNext = false;
  return pathname.split("/").map((segment) => {
    const decoded = decodedSegment(segment);
    const redact = redactNext || SECRET_NAME.test(decoded) || SECRET_SHAPED.test(decoded);
    redactNext = SECRET_NAME.test(decoded);
    return redact ? "[redacted]" : segment;
  }).join("/");
}

function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function safeLocation(document: Document): string {
  try {
    return sanitizeWebLocation(document.location?.href ?? "about:blank");
  } catch {
    return "about:blank";
  }
}

/** Return the mounted preview document location after same-origin validation and redaction. */
export function captureVisibleWebLocation(iframe: HTMLIFrameElement): WebCaptureResult<string> {
  const origin = sameOrigin(iframe);
  return origin.ok ? { ok: true, value: safeLocation(origin.value) } : origin;
}

function collectVisibleText(
  document: Document,
  input: Pick<WebCaptureInput, "deadline" | "signal">,
): WebCaptureResult<{ readonly text: string; readonly truncated: boolean; readonly originalCount: number }> {
  const root = document.body ?? document.documentElement;
  const state: VisibleTextState = { text: "", originalCount: 0, truncated: false };
  const stack = seedTextNodeStack(root, state);
  let visited = 0;
  while (stack.length > 0) {
    const stop = cancelledOrTimedOut(input);
    if (stop) return failure(stop);
    visited += 1;
    if (visited > MAX_DOM_NODES) {
      state.truncated = true;
      break;
    }
    visitVisibleTextNode(document, stack.pop()!, stack, state);
    if (state.truncated && state.text.length >= BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS) break;
  }
  return { ok: true, value: { text: state.text, truncated: state.truncated, originalCount: state.originalCount } };
}

function seedTextNodeStack(
  root: Element,
  state: Pick<VisibleTextState, "originalCount" | "truncated">,
): Array<{ readonly node: Node; readonly sensitive: boolean }> {
  const count = root.childNodes.length;
  const limit = Math.min(count, MAX_DOM_NODES);
  state.originalCount = count > limit ? count : 0;
  state.truncated = count > limit;
  const stack: Array<{ readonly node: Node; readonly sensitive: boolean }> = [];
  for (let index = limit - 1; index >= 0; index -= 1) stack.push({ node: root.childNodes[index]!, sensitive: false });
  return stack;
}

function visitVisibleTextNode(
  document: Document,
  current: { readonly node: Node; readonly sensitive: boolean },
  stack: Array<{ readonly node: Node; readonly sensitive: boolean }>,
  state: VisibleTextState,
): void {
  if (current.node.nodeType === Node.ELEMENT_NODE) {
    enqueueVisibleTextChildren(document, current.node as Element, stack, state);
    return;
  }
  if (!current.sensitive) appendVisibleText(current.node, state);
}

function enqueueVisibleTextChildren(
  document: Document,
  element: Element,
  stack: Array<{ readonly node: Node; readonly sensitive: boolean }>,
  state: VisibleTextState,
): void {
  if (!isVisibleElement(document, element) || isSensitiveElement(element)) return;
  const children = element.childNodes;
  const limit = Math.min(children.length, MAX_DOM_NODES);
  if (children.length > limit) {
    state.truncated = true;
    state.originalCount = Math.max(state.originalCount, children.length);
  }
  for (let index = limit - 1; index >= 0; index -= 1) stack.push({ node: children[index]!, sensitive: false });
  if (stack.length > MAX_DOM_NODES) {
    stack.length = MAX_DOM_NODES;
    state.truncated = true;
  }
}

function appendVisibleText(current: Node, state: VisibleTextState): void {
  if (current.nodeType !== Node.TEXT_NODE) return;
  const value = current.textContent ?? "";
  state.originalCount += value.length;
  if (state.text.length < BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS) {
    state.text += sanitizeText(value, BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS - state.text.length);
  }
  if (state.text.length >= BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS || state.originalCount > BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS) {
    state.truncated = true;
    state.originalCount = BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS + 1;
  }
}

function collectElements(
  document: Document,
  input: Pick<WebCaptureInput, "deadline" | "signal">,
): WebCaptureResult<{ readonly items: BrowserAutomationElement[]; readonly truncated: boolean; readonly originalCount: number }> {
  const root = document.body ?? document.documentElement;
  const state: ElementCollectionState = { items: [], interactiveCount: 0, originalCount: 0, truncated: false };
  const stack = seedElementStack(root, state);
  let index = 0;
  while (stack.length > 0) {
    const stop = cancelledOrTimedOut(input);
    if (stop) return failure(stop);
    if (index >= MAX_DOM_NODES) {
      state.truncated = true;
      break;
    }
    index += 1;
    const current = stack.pop()!;
    if (current.nodeType === Node.ELEMENT_NODE) collectElement(document, current as Element, stack, state, index);
  }
  return { ok: true, value: { items: state.items, truncated: state.truncated, originalCount: elementOriginalCount(state) } };
}

function seedElementStack(root: Element, state: Pick<ElementCollectionState, "originalCount" | "truncated">): Node[] {
  const count = root.childNodes.length;
  const limit = Math.min(count, MAX_DOM_NODES);
  state.originalCount = count > limit ? count : 0;
  state.truncated = count > limit;
  const stack: Node[] = [];
  for (let index = limit - 1; index >= 0; index -= 1) stack.push(root.childNodes[index]!);
  return stack;
}

function collectElement(
  document: Document,
  element: Element,
  stack: Node[],
  state: ElementCollectionState,
  index: number,
): void {
  if (!isVisibleElement(document, element)) return;
  const tag = element.tagName.toLowerCase();
  if (isSensitiveElement(element)) {
    if (INTERACTIVE_TAGS.has(tag)) state.interactiveCount += 1;
    return;
  }
  enqueueElementChildren(element, stack, state);
  if (!INTERACTIVE_TAGS.has(tag)) return;
  state.interactiveCount += 1;
  if (state.items.length >= BROWSER_AUTOMATION_MAX_ELEMENTS) {
    state.truncated = true;
    return;
  }
  const rect = (element as HTMLElement).getBoundingClientRect?.();
  if (!rect) return;
  state.items.push(browserAutomationElement(element, rect, index));
}

function enqueueElementChildren(element: Element, stack: Node[], state: ElementCollectionState): void {
  const children = element.childNodes;
  const limit = Math.min(children.length, MAX_DOM_NODES);
  if (children.length > limit) {
    state.truncated = true;
    state.originalCount = Math.max(state.originalCount, children.length);
  }
  for (let index = limit - 1; index >= 0; index -= 1) stack.push(children[index]!);
  if (stack.length > MAX_DOM_NODES) {
    stack.length = MAX_DOM_NODES;
    state.truncated = true;
  }
}

function browserAutomationElement(element: Element, rect: DOMRect, index: number): BrowserAutomationElement {
  const control = element as HTMLInputElement & HTMLButtonElement;
  return {
    semanticId: element.id || `web-${index + 1}`,
    role: element.getAttribute("role") || element.tagName.toLowerCase(),
    accessibleName: sanitizeText(element.getAttribute("aria-label") || element.textContent || ""),
    value: sanitizeText(control.value || ""),
    disabled: control.disabled === true,
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}

function elementOriginalCount(state: ElementCollectionState): number {
  return state.truncated
    ? Math.max(BROWSER_AUTOMATION_MAX_ELEMENTS + 1, state.interactiveCount, state.originalCount)
    : state.interactiveCount;
}

/** Capture bounded, redacted semantic data from the same-origin iframe. */
export async function captureVisibleWebSnapshot(input: WebCaptureInput & { readonly includeScreenshot: boolean }): Promise<WebCaptureResult<BrowserAutomationSnapshot>> {
  const origin = sameOrigin(input.iframe);
  if (!origin.ok) return origin;
  const stop = cancelledOrTimedOut(input);
  if (stop) return failure(stop);
  const text = collectVisibleText(origin.value, input);
  if (!text.ok) return text;
  const elements = collectElements(origin.value, input);
  if (!elements.ok) return elements;
  const screenshot = await optionalScreenshot(input);
  if (!screenshot.ok) return screenshot;
  return { ok: true, value: snapshotValue(origin.value, text.value, elements.value, screenshot.value) };
}

function optionalScreenshot(input: WebCaptureInput & { readonly includeScreenshot: boolean }): Promise<WebCaptureResult<BrowserAutomationScreenshot | undefined>> {
  return input.includeScreenshot
    ? captureVisibleWebScreenshot(input)
    : Promise.resolve({ ok: true, value: undefined });
}

function snapshotValue(
  document: Document,
  text: { readonly text: string; readonly truncated: boolean; readonly originalCount: number },
  elements: { readonly items: BrowserAutomationElement[]; readonly truncated: boolean; readonly originalCount: number },
  screenshot: BrowserAutomationScreenshot | undefined,
): BrowserAutomationSnapshot {
  const empty = { truncated: false as const };
  return {
    url: safeLocation(document),
    title: sanitizeText(document.title),
    loading: document.readyState !== "complete",
    visibleText: text.text,
    visibleTextTruncation: text.truncated ? { truncated: true, originalCount: text.originalCount, reason: "character-limit" } : empty,
    elements: elements.items,
    elementsTruncation: elements.truncated ? { truncated: true, originalCount: elements.originalCount, reason: "entry-limit" } : empty,
    accessibility: [],
    accessibilityTruncation: empty,
    console: [],
    consoleTruncation: empty,
    network: [],
    networkTruncation: empty,
    actions: [],
    actionsTruncation: empty,
    ...(screenshot ? { screenshot } : {}),
  };
}
