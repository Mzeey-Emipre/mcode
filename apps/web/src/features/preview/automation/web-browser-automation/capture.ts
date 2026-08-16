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

function failure(code: WebCaptureFailureCode): WebCaptureResult<never> { return { ok: false, code }; }
function cancelledOrTimedOut(input: Pick<WebCaptureInput, "deadline" | "signal">): WebCaptureFailureCode | null {
  if (input.signal?.aborted) return "OPERATION_CANCELLED";
  if (Date.now() >= input.deadline) return "TIMEOUT";
  return null;
}
function sanitizeText(value: string, max = MAX_TEXT_PER_NODE): string { return value.replace(SECRET_VALUE, "[redacted]").slice(0, max); }
function isSensitiveElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input" && (element.getAttribute("type") ?? "").toLowerCase() === "password") return true;
  for (let index = 0; index < Math.min(element.attributes.length, MAX_ATTRIBUTE_COUNT); index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute && (SECRET_NAME.test(attribute.name) || SECRET_NAME.test(attribute.value))) return true;
  }
  return false;
}

function isVisibleElement(document: Document, element: Element): boolean {
  if (SKIP_TAGS.has(element.tagName.toLowerCase()) || element.hasAttribute("hidden") || element.hasAttribute("inert") || element.getAttribute("aria-hidden") === "true") return false;
  try {
    const style = document.defaultView?.getComputedStyle(element);
    if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden" || style.opacity === "0")) return false;
  } catch { return false; }
  return true;
}

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }

function copyComputedStyle(document: Document, source: Element, clone: HTMLElement, budget: { properties: number; bytes: number }): WebCaptureResult<void> {
  try {
    const style = document.defaultView?.getComputedStyle(source);
    if (!style) return { ok: true, value: undefined };
    const declarations: string[] = [];
    for (let index = 0; index < style.length && index < MAX_STYLE_PROPERTIES; index += 1) {
      if (budget.properties >= MAX_STYLE_PROPERTIES) return failure("RESULT_TOO_LARGE");
      const property = style.item(index);
      const value = style.getPropertyValue(property);
      if (!property || !value || property.startsWith("--") || property === "content" || /url\s*\(/i.test(value)) continue;
      const declaration = `${property}:${value};`;
      const bytes = utf8Bytes(declaration);
      if (budget.bytes + bytes > MAX_STYLE_BYTES) return failure("RESULT_TOO_LARGE");
      budget.properties += 1;
      budget.bytes += bytes;
      declarations.push(declaration);
    }
    if (style.length > MAX_STYLE_PROPERTIES) return failure("RESULT_TOO_LARGE");
    if (declarations.length > 0) clone.setAttribute("style", declarations.join(""));
    return { ok: true, value: undefined };
  } catch { return failure("INTERNAL_ERROR"); }
}

function cloneBoundedDocument(document: Document, input: Pick<WebCaptureInput, "deadline" | "signal">): WebCaptureResult<{ readonly root: HTMLElement; readonly truncated: boolean; readonly originalCount: number; readonly serialized: string }> {
  const source = document.body ?? document.documentElement;
  const root = source.cloneNode(false) as HTMLElement;
  const queue: Array<{ readonly source: Node; readonly clone: Node; readonly sensitive: boolean }> = [{ source, clone: root, sensitive: false }];
  let cursor = 0;
  let count = 1;
  let originalCount = 1;
  let truncated = false;
  let visitedSourceChildren = 0;
  let attributeCount = 0;
  let attributeBytes = 0;
  const styleBudget = { properties: 0, bytes: 0 };
  for (let index = root.attributes.length - 1; index >= 0; index -= 1) root.removeAttribute(root.attributes.item(index)!.name);
  for (let index = 0; index < source.attributes.length; index += 1) {
    const attribute = source.attributes.item(index)!;
    attributeCount += 1;
    attributeBytes += utf8Bytes(attribute.name) + utf8Bytes(attribute.value);
    if (attributeCount > MAX_ATTRIBUTE_COUNT || attributeBytes > MAX_ATTRIBUTE_BYTES) return failure("RESULT_TOO_LARGE");
    if (RESOURCE_ATTRIBUTES.has(attribute.name.toLowerCase()) || attribute.name.toLowerCase().startsWith("on")) continue;
    root.setAttribute(attribute.name, SECRET_NAME.test(attribute.name) || SECRET_SHAPED.test(attribute.value) ? "[redacted]" : sanitizeText(attribute.value, MAX_ATTRIBUTE_CHARS));
  }
  const rootStyle = copyComputedStyle(document, source, root, styleBudget);
  if (!rootStyle.ok) return rootStyle;
  while (cursor < queue.length) {
    const current = queue[cursor++];
    for (let child = current.source.firstChild; child; child = child.nextSibling) {
      visitedSourceChildren += 1;
      if (visitedSourceChildren > MAX_SOURCE_CHILDREN) return failure("RESULT_TOO_LARGE");
      if (visitedSourceChildren % 32 === 0) {
        const stop = cancelledOrTimedOut(input);
        if (stop) return failure(stop);
      }
      if (count >= MAX_DOM_NODES) {
        truncated = true;
        originalCount = MAX_DOM_NODES + 1;
        break;
      }
      originalCount += 1;
      if (child.nodeType === Node.TEXT_NODE) {
        if (current.sensitive) continue;
        current.clone.appendChild(document.createTextNode(sanitizeText(child.textContent ?? "")));
        count += 1;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      const tag = element.tagName.toLowerCase();
      if (!isVisibleElement(document, element)) continue;
      const sensitive = current.sensitive || isSensitiveElement(element);
      const cloned = element.cloneNode(false) as HTMLElement;
      for (let index = 0; index < element.attributes.length; index += 1) {
        const attribute = element.attributes.item(index)!;
        attributeCount += 1;
        attributeBytes += utf8Bytes(attribute.name) + utf8Bytes(attribute.value);
        if (attributeCount > MAX_ATTRIBUTE_COUNT || attributeBytes > MAX_ATTRIBUTE_BYTES) return failure("RESULT_TOO_LARGE");
        if (RESOURCE_ATTRIBUTES.has(attribute.name.toLowerCase()) || attribute.name.toLowerCase().startsWith("on")) continue;
        cloned.setAttribute(
          attribute.name,
          SECRET_NAME.test(attribute.name) || SECRET_SHAPED.test(attribute.value)
            ? "[redacted]"
            : sanitizeText(attribute.value, MAX_ATTRIBUTE_CHARS),
        );
      }
      const styled = copyComputedStyle(document, element, cloned, styleBudget);
      if (!styled.ok) return styled;
      if (sensitive) {
        cloned.textContent = "[redacted]";
        cloned.setAttribute("value", "");
      } else if (["input", "textarea", "select"].includes(tag)) {
        cloned.textContent = "";
        cloned.setAttribute("value", "");
      }
      current.clone.appendChild(cloned);
      if (!sensitive) queue.push({ source: child, clone: cloned, sensitive });
      count += 1;
    }
  }
  let serialized: string;
  try { serialized = new XMLSerializer().serializeToString(root); } catch { return failure("INTERNAL_ERROR"); }
  if (utf8Bytes(serialized) > MAX_SERIALIZED_BYTES) return failure("RESULT_TOO_LARGE");
  return { ok: true, value: { root, truncated, originalCount, serialized } };
}

function sameOrigin(iframe: HTMLIFrameElement): WebCaptureResult<Document> {
  try {
    const frameWindow = iframe.contentWindow;
    const document = iframe.contentDocument;
    if (!frameWindow || !document || frameWindow.location.origin !== window.location.origin) return failure("CROSS_ORIGIN");
    void document.body;
    return { ok: true, value: document };
  } catch { return failure("CROSS_ORIGIN"); }
}

async function waitForImage(image: HTMLImageElement, source: string, input: Pick<WebCaptureInput, "deadline" | "signal">): Promise<WebCaptureResult<void>> {
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
    try { image.src = source; } catch { finish(failure("INTERNAL_ERROR")); }
  });
}

function encodedBytes(dataBase64: string): number { return Math.floor(dataBase64.length * 3 / 4); }

/** Capture a bounded, redacted PNG of the iframe's visible viewport. */
export async function captureVisibleWebScreenshot(input: WebCaptureInput): Promise<WebCaptureResult<BrowserAutomationScreenshot>> {
  try {
    const origin = sameOrigin(input.iframe);
    if (!origin.ok) return origin;
    const stop = cancelledOrTimedOut(input);
    if (stop) return failure(stop);
    const width = Math.max(1, Math.min(BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH, Math.floor(input.maxWidth), input.iframe.clientWidth || BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH));
    const requestedWidth = width;
    const height = Math.max(1, Math.min(10_000, input.iframe.clientHeight || 720, Math.floor(MAX_CANVAS_AREA / width)));
    const clone = cloneBoundedDocument(origin.value, input);
    if (!clone.ok) return clone;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${clone.value.serialized}</foreignObject></svg>`;
    if (utf8Bytes(svg) > MAX_SERIALIZED_BYTES) return failure("RESULT_TOO_LARGE");
    const image = new Image();
    const loaded = await waitForImage(image, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, input);
    if (!loaded.ok) return loaded;
    const canvas = origin.value.createElement("canvas");
    let currentWidth = width;
    let currentHeight = height;
    let encoded = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stopAfterImage = cancelledOrTimedOut(input);
      if (stopAfterImage) return failure(stopAfterImage);
      canvas.width = currentWidth;
      canvas.height = currentHeight;
      const context = canvas.getContext("2d");
      if (!context) return failure("INTERNAL_ERROR");
      try {
        context.clearRect(0, 0, currentWidth, currentHeight);
        context.drawImage(image, 0, 0, currentWidth, currentHeight);
        encoded = canvas.toDataURL("image/png");
      } catch { return failure("CROSS_ORIGIN"); }
      if (!encoded.startsWith("data:image/png;base64,")) return failure("INTERNAL_ERROR");
      if (encodedBytes(encoded.slice("data:image/png;base64,".length)) <= MAX_CAPTURE_DATA_BYTES) break;
      currentWidth = Math.max(1, Math.floor(currentWidth / 2));
      currentHeight = Math.max(1, Math.floor(currentHeight / 2));
    }
    const dataBase64 = encoded.slice("data:image/png;base64,".length);
    if (encodedBytes(dataBase64) > MAX_CAPTURE_DATA_BYTES) return failure("RESULT_TOO_LARGE");
    const widthTruncated = currentWidth < requestedWidth;
    const truncation = clone.value.truncated || widthTruncated
      ? {
          truncated: true as const,
          originalCount: Math.max(
            currentWidth + 1,
            widthTruncated ? requestedWidth : 0,
            clone.value.truncated ? clone.value.originalCount : 0,
          ),
          reason: "entry-limit" as const,
        }
      : { truncated: false as const };
    return { ok: true, value: {
      mediaType: "image/png", dataBase64, width: currentWidth, height: currentHeight,
      truncation,
    } };
  } catch { return failure("INTERNAL_ERROR"); }
}

/** Remove credentials, query, fragment, and token-shaped path segments from a URL. */
export function sanitizeWebLocation(value: string): string {
  try {
    const parsed = new URL(value, window.location.href);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    let redactNext = false;
    parsed.pathname = parsed.pathname.split("/").map((segment) => {
      let decoded = segment;
      try { decoded = decodeURIComponent(segment); } catch { /* Keep malformed path segments unchanged. */ }
      const redact = redactNext || SECRET_NAME.test(decoded) || SECRET_SHAPED.test(decoded);
      redactNext = SECRET_NAME.test(decoded);
      return redact ? "[redacted]" : segment;
    }).join("/");
    return parsed.toString();
  } catch { return "about:blank"; }
}

function safeLocation(document: Document): string {
  try { return sanitizeWebLocation(document.location?.href ?? "about:blank"); } catch { return "about:blank"; }
}

/** Return the mounted preview document location after same-origin validation and redaction. */
export function captureVisibleWebLocation(iframe: HTMLIFrameElement): WebCaptureResult<string> {
  const origin = sameOrigin(iframe);
  if (!origin.ok) return origin;
  return { ok: true, value: safeLocation(origin.value) };
}
function collectVisibleText(
  document: Document,
  input: Pick<WebCaptureInput, "deadline" | "signal">,
): WebCaptureResult<{ readonly text: string; readonly truncated: boolean; readonly originalCount: number }> {
  const root = document.body ?? document.documentElement;
  const stack: Array<{ readonly node: Node; readonly sensitive: boolean }> = [];
  const rootChildCount = root.childNodes.length;
  const rootChildLimit = Math.min(rootChildCount, MAX_DOM_NODES);
  let text = "";
  let originalCount = rootChildCount > rootChildLimit ? rootChildCount : 0;
  let truncated = rootChildCount > rootChildLimit;
  for (let index = rootChildLimit - 1; index >= 0; index -= 1) stack.push({ node: root.childNodes[index]!, sensitive: false });
  let visited = 0;
  while (stack.length > 0) {
    const stop = cancelledOrTimedOut(input);
    if (stop) return failure(stop);
    const current = stack.pop()!;
    visited += 1;
    if (visited > MAX_DOM_NODES) { truncated = true; break; }
    if (current.node.nodeType === Node.ELEMENT_NODE) {
      const element = current.node as Element;
      if (!isVisibleElement(document, element)) continue;
      const sensitive = current.sensitive || isSensitiveElement(element);
      if (sensitive) continue;
      const childCount = element.childNodes.length;
      const childLimit = Math.min(childCount, MAX_DOM_NODES);
      if (childCount > childLimit) {
        truncated = true;
        originalCount = Math.max(originalCount, childCount);
      }
      for (let index = childLimit - 1; index >= 0; index -= 1) stack.push({ node: element.childNodes[index]!, sensitive });
      if (stack.length > MAX_DOM_NODES) { stack.length = MAX_DOM_NODES; truncated = true; }
      continue;
    }
    if (current.sensitive || current.node.nodeType !== Node.TEXT_NODE) continue;
    const value = current.node.textContent ?? "";
    originalCount += value.length;
    if (text.length < BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS) {
      text += sanitizeText(value, BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS - text.length);
    }
    if (text.length >= BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS || originalCount > BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS) {
      truncated = true;
      originalCount = BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS + 1;
      break;
    }
  }
  return { ok: true, value: { text, truncated, originalCount } };
}
function collectElements(
  document: Document,
  input: Pick<WebCaptureInput, "deadline" | "signal">,
): WebCaptureResult<{ readonly items: BrowserAutomationElement[]; readonly truncated: boolean; readonly originalCount: number }> {
  const items: BrowserAutomationElement[] = [];
  const root = document.body ?? document.documentElement;
  const stack: Node[] = [];
  const rootChildCount = root.childNodes.length;
  const rootChildLimit = Math.min(rootChildCount, MAX_DOM_NODES);
  let index = 0;
  let interactiveCount = 0;
  let originalCount = rootChildCount > rootChildLimit ? rootChildCount : 0;
  let truncated = rootChildCount > rootChildLimit;
  for (let childIndex = rootChildLimit - 1; childIndex >= 0; childIndex -= 1) stack.push(root.childNodes[childIndex]!);
  while (stack.length > 0) {
    const stop = cancelledOrTimedOut(input);
    if (stop) return failure(stop);
    if (index >= MAX_DOM_NODES) {
      truncated = true;
      break;
    }
    const current = stack.pop()!;
    index += 1;
    if (current.nodeType !== Node.ELEMENT_NODE) continue;
    const element = current as Element;
    if (!isVisibleElement(document, element)) continue;
    if (isSensitiveElement(element)) {
      if (["input", "textarea", "select", "button", "a"].includes(element.tagName.toLowerCase())) interactiveCount += 1;
      continue;
    }
    const childCount = element.childNodes.length;
    const childLimit = Math.min(childCount, MAX_DOM_NODES);
    if (childCount > childLimit) {
      truncated = true;
      originalCount = Math.max(originalCount, childCount);
    }
    for (let childIndex = childLimit - 1; childIndex >= 0; childIndex -= 1) stack.push(element.childNodes[childIndex]!);
    if (stack.length > MAX_DOM_NODES) { stack.length = MAX_DOM_NODES; truncated = true; }
    const tag = element.tagName.toLowerCase();
    if (!["button", "a", "input", "textarea", "select"].includes(tag)) {
      continue;
    }
    interactiveCount += 1;
    if (items.length >= BROWSER_AUTOMATION_MAX_ELEMENTS) {
      truncated = true;
      break;
    }
    const rect = (element as HTMLElement).getBoundingClientRect?.();
    if (!rect) {
      continue;
    }
    items.push({ semanticId: element.id || `web-${index + 1}`, role: element.getAttribute("role") || element.tagName.toLowerCase(), accessibleName: sanitizeText(element.getAttribute("aria-label") || element.textContent || ""), ...(isSensitiveElement(element) ? {} : { value: sanitizeText((element as HTMLInputElement).value || "") }), disabled: (element as HTMLButtonElement).disabled === true, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  }
  return { ok: true, value: { items, truncated, originalCount: truncated ? Math.max(BROWSER_AUTOMATION_MAX_ELEMENTS + 1, interactiveCount, originalCount) : interactiveCount } };
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
  const screenshot = input.includeScreenshot ? await captureVisibleWebScreenshot(input) : null;
  if (screenshot && !screenshot.ok) return screenshot;
  const empty = { truncated: false as const };
  return { ok: true, value: {
     url: safeLocation(origin.value), title: sanitizeText(origin.value.title), loading: origin.value.readyState !== "complete",
     visibleText: text.value.text, visibleTextTruncation: text.value.truncated ? { truncated: true, originalCount: text.value.originalCount, reason: "character-limit" } : empty,
     elements: elements.value.items, elementsTruncation: elements.value.truncated ? { truncated: true, originalCount: elements.value.originalCount, reason: "entry-limit" } : empty,
    accessibility: [], accessibilityTruncation: empty, console: [], consoleTruncation: empty, network: [], networkTruncation: empty, actions: [], actionsTruncation: empty,
    ...(screenshot?.ok ? { screenshot: screenshot.value } : {}),
  } };
}
