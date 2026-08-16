import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_ELEMENTS,
  BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS,
  BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH,
  type BrowserAutomationHostDispatch,
  type BrowserAutomationResult,
  type BrowserAutomationResponse,
} from "@mcode/contracts";
import { captureVisibleWebScreenshot } from "./web-browser-automation/capture";
import { getWebBrowserSemanticRegistry } from "./webBrowserSemanticRegistry";

const WEB_SNAPSHOT_MAX_SCAN_NODES = 8_192;
const WEB_SNAPSHOT_MAX_ELEMENT_TEXT = 1_024;
const WEB_SNAPSHOT_MAX_ELEMENT_TEXT_NODES = 256;
const WEB_SNAPSHOT_MAX_ANCESTORS = 256;

interface SnapshotNode {
  node: Node;
  hidden: boolean;
}

interface SnapshotBudget {
  visited: number;
  pending: number;
}

function pushSnapshotNode(
  stack: SnapshotNode[],
  node: Node,
  budget: SnapshotBudget,
  hidden = false,
): boolean {
  if (budget.visited + budget.pending >= WEB_SNAPSHOT_MAX_SCAN_NODES) return false;
  stack.push({ node, hidden });
  budget.pending += 1;
  return true;
}

function popSnapshotNode(stack: SnapshotNode[], budget: SnapshotBudget): SnapshotNode | undefined {
  const entry = stack.pop();
  if (!entry) return undefined;
  budget.pending -= 1;
  budget.visited += 1;
  return entry;
}

type WebIframe = HTMLIFrameElement & { dataset: DOMStringMap };
type MechanicalInspectResult = Omit<Extract<BrowserAutomationResult, { operation: "inspect" }>, "readiness" | "observationRef" | "capabilities" | "guidance" | "capabilityRevision">;
type MechanicalStatusResult = Omit<Extract<BrowserAutomationResult, { operation: "status" }>, "capabilities" | "capabilityRevision">;

type WebFailureCode =
  | "CROSS_ORIGIN"
  | "DEADLINE_EXCEEDED"
  | "INTERNAL_ERROR"
  | "NAVIGATION_FAILED"
  | "OPERATION_CANCELLED"
  | "RESULT_TOO_LARGE"
  | "TAB_UNAVAILABLE"
  | "UNSUPPORTED_OPERATION";

type WebFailureMetadata = {
  stage: "validation" | "allocation" | "observation" | "effect" | "recovery" | "transport";
  effect: "none" | "created" | "closed" | "preserved" | "unknown";
  recovery: "none" | "retry" | "refresh" | "reopen" | "manual";
};

const WEB_FAILURE_METADATA: Record<WebFailureCode, WebFailureMetadata> = {
  CROSS_ORIGIN: { stage: "observation", effect: "none", recovery: "manual" },
  DEADLINE_EXCEEDED: { stage: "recovery", effect: "unknown", recovery: "retry" },
  INTERNAL_ERROR: { stage: "transport", effect: "unknown", recovery: "retry" },
  NAVIGATION_FAILED: { stage: "effect", effect: "unknown", recovery: "retry" },
  OPERATION_CANCELLED: { stage: "recovery", effect: "preserved", recovery: "none" },
  RESULT_TOO_LARGE: { stage: "observation", effect: "none", recovery: "retry" },
  TAB_UNAVAILABLE: { stage: "allocation", effect: "unknown", recovery: "retry" },
  UNSUPPORTED_OPERATION: { stage: "validation", effect: "none", recovery: "manual" },
};

function response(
  dispatch: BrowserAutomationHostDispatch,
  result: BrowserAutomationResult,
): BrowserAutomationResponse {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: dispatch.request.requestId,
    sequence: dispatch.request.sequence,
    ok: true,
    result,
  } as BrowserAutomationResponse;
}

function failure(
  dispatch: BrowserAutomationHostDispatch,
  code: WebFailureCode,
  message: string,
): BrowserAutomationResponse {
  const metadata = WEB_FAILURE_METADATA[code];
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: dispatch.request.requestId,
    sequence: dispatch.request.sequence,
    ok: false,
    error: {
      code,
      message,
      retryable: code !== "CROSS_ORIGIN" && code !== "UNSUPPORTED_OPERATION",
      ...metadata,
      correlationId: globalThis.crypto.randomUUID(),
    },
  };
}

function findIframe(dispatch: BrowserAutomationHostDispatch): WebIframe | null {
  const candidates = [...document.querySelectorAll<HTMLIFrameElement>("iframe")]
    .filter((candidate) => candidate.dataset.threadId === dispatch.target.threadId && candidate.dataset.tabId === dispatch.target.tabId);
  const automationSurface = candidates.find((candidate) => {
    let node: Element | null = candidate.parentElement;
    while (node) {
      if (node.getAttribute("data-automation-persistent-scope") === dispatch.target.threadId) return true;
      node = node.parentElement;
    }
    return false;
  });
  if (automationSurface) return automationSurface as WebIframe;
  const visible = candidates.find((candidate) => {
    let node: HTMLElement | null = candidate;
    let depth = 0;
    while (node && depth < WEB_SNAPSHOT_MAX_ANCESTORS) {
      if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("inert")) return false;
      node = node.parentElement;
      depth += 1;
    }
    return !node;
  });
  return (visible ?? null) as WebIframe | null;
}

const CREDENTIAL_AUTOCOMPLETE_TOKENS = new Set([
  "current-password",
  "new-password",
  "username",
  "one-time-code",
  "webauthn",
]);

function isCredentialValue(element: Element): boolean {
  if (element.getAttribute("type")?.toLowerCase() === "password") return true;
  const autocomplete = element.getAttribute("autocomplete")?.toLowerCase().split(/\s+/) ?? [];
  return autocomplete.some((token) => CREDENTIAL_AUTOCOMPLETE_TOKENS.has(token));
}

function checkAbort(dispatch: BrowserAutomationHostDispatch, signal: AbortSignal): BrowserAutomationResponse | null {
  if (signal.aborted) {
    return failure(dispatch, "OPERATION_CANCELLED", "Browser operation was cancelled");
  }
  if (Date.now() >= dispatch.request.deadline) {
    return failure(dispatch, "DEADLINE_EXCEEDED", "Browser request deadline has elapsed");
  }
  return null;
}

function sameOrigin(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}

function currentDocument(iframe: WebIframe): Document | null {
  try {
    const document = iframe.contentDocument;
    if (!document) return null;
    const origin = document.location?.origin;
    if (origin && origin !== "null" && origin !== window.location.origin) return null;
    if (origin === "null") {
      const frameUrl = new URL(iframe.src || "about:blank", window.location.href);
      if (frameUrl.protocol !== "about:" && frameUrl.origin !== window.location.origin) return null;
    }
    return document;
  } catch {
    return null;
  }
}

function isHiddenElementSelf(element: Element): boolean {
  if (element.hasAttribute("hidden") || element.hasAttribute("inert") || element.getAttribute("aria-hidden") === "true") return true;
  const style = element.getAttribute("style") ?? "";
  if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*(?:hidden|collapse)/i.test(style)) return true;
  const view = element.ownerDocument.defaultView;
  if (view) {
    const computed = view.getComputedStyle(element);
    if (computed.display === "none" || computed.visibility === "hidden" || computed.visibility === "collapse") return true;
  }
  return false;
}

function isSemanticElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  if (tagName === "input" && (element.getAttribute("type") ?? "").toLowerCase() === "hidden") return false;
  return tagName === "a" || tagName === "button" || tagName === "input" || tagName === "select" ||
    tagName === "textarea" || element.hasAttribute("role");
}

function boundedElementText(element: Element, limit: number, budget: SnapshotBudget): { text: string; budgetExhausted: boolean } {
  const parts: string[] = [];
  let length = 0;
  const stack: SnapshotNode[] = [];
  let budgetExhausted = false;
  let localVisited = 0;
  let localPending = 0;
  const pushLocal = (node: Node, hidden = false): boolean => {
    if (localVisited + localPending >= WEB_SNAPSHOT_MAX_ELEMENT_TEXT_NODES ||
      budget.visited + budget.pending >= WEB_SNAPSHOT_MAX_SCAN_NODES) return false;
    stack.push({ node, hidden });
    localPending += 1;
    budget.pending += 1;
    return true;
  };
  const popLocal = (): SnapshotNode | undefined => {
    const entry = stack.pop();
    if (!entry) return undefined;
    localPending -= 1;
    localVisited += 1;
    budget.pending -= 1;
    budget.visited += 1;
    return entry;
  };
  const children = element.childNodes;
  const initialChildLimit = Math.min(
    children.length,
    Math.max(0, WEB_SNAPSHOT_MAX_ELEMENT_TEXT_NODES - localVisited - localPending),
    Math.max(0, WEB_SNAPSHOT_MAX_SCAN_NODES - budget.visited - budget.pending),
  );
  if (initialChildLimit < children.length) budgetExhausted = true;
  for (let index = initialChildLimit - 1; index >= 0; index -= 1) {
    if (!pushLocal(children[index]!)) {
      budgetExhausted = true;
      break;
    }
  }
  while (stack.length > 0 && length < limit && localVisited < WEB_SNAPSHOT_MAX_ELEMENT_TEXT_NODES && budget.visited < WEB_SNAPSHOT_MAX_SCAN_NODES) {
    const entry = popLocal()!;
    const node = entry.node;
    if (node.nodeType === 3) {
      if (entry.hidden) continue;
      const value = node.nodeValue ?? "";
      const retained = value.slice(0, limit - length);
      parts.push(retained);
      length += retained.length;
      continue;
    }
    if (node.nodeType !== 1 || entry.hidden) continue;
    const hidden = isHiddenElementSelf(node as Element);
    if (hidden) continue;
    const children = node.childNodes;
    const childLimit = Math.min(
      children.length,
      Math.max(0, WEB_SNAPSHOT_MAX_ELEMENT_TEXT_NODES - localVisited - localPending),
      Math.max(0, WEB_SNAPSHOT_MAX_SCAN_NODES - budget.visited - budget.pending),
    );
    if (childLimit < children.length) budgetExhausted = true;
    for (let index = childLimit - 1; index >= 0; index -= 1) {
      if (!pushLocal(children[index]!, hidden)) {
        budgetExhausted = true;
        break;
      }
    }
  }
  if (stack.length > 0) budgetExhausted = true;
  budget.pending -= localPending;
  return { text: parts.join("").trim().slice(0, limit), budgetExhausted };
}

interface BoundedSnapshotData {
  visibleText: string;
  visibleTextTruncation: { truncated: false } | { truncated: true; originalCount: number; reason: "character-limit" | "entry-limit" };
  elements: Array<{
    semanticId: string;
    role: string;
    accessibleName: string;
    value?: string;
    disabled: boolean;
    bounds: { x: number; y: number; width: number; height: number };
  }>;
  elementsTruncation: { truncated: false } | { truncated: true; originalCount: number; reason: "entry-limit" };
}

function collectBoundedSnapshot(document: Document): BoundedSnapshotData {
  const elements: BoundedSnapshotData["elements"] = [];
  const textParts: string[] = [];
  let textLength = 0;
  let textTruncated = false;
  let elementCount = 0;
  let scanLimitReached = false;
  const root = document.body ?? document.documentElement;
  const budget: SnapshotBudget = { visited: 0, pending: 0 };
  const stack: SnapshotNode[] = [];
  if (root && !pushSnapshotNode(stack, root, budget)) scanLimitReached = true;
  while (stack.length > 0 && budget.visited < WEB_SNAPSHOT_MAX_SCAN_NODES) {
    if ((textTruncated || textLength >= BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS) && elementCount > BROWSER_AUTOMATION_MAX_ELEMENTS) {
      if (textLength >= BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS) textTruncated = true;
      break;
    }
    const entry = popSnapshotNode(stack, budget)!;
    const node = entry.node;
    if (node.nodeType === 3) {
      if (entry.hidden) continue;
      const value = node.nodeValue ?? "";
      if (!textTruncated && textLength < BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS) {
        const retained = value.slice(0, BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS - textLength);
        textParts.push(retained);
        textLength += retained.length;
        if (retained.length < value.length) textTruncated = true;
      } else if (value.length > 0) {
        textTruncated = true;
      }
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (entry.hidden || isHiddenElementSelf(element) || ["script", "style", "noscript", "template"].includes(element.tagName.toLowerCase())) continue;
    if (isSemanticElement(element)) {
      elementCount += 1;
      if (elements.length < BROWSER_AUTOMATION_MAX_ELEMENTS) {
        const bounds = (element as HTMLElement).getBoundingClientRect();
        const accessibleName = element.getAttribute("aria-label")?.slice(0, WEB_SNAPSHOT_MAX_ELEMENT_TEXT) || boundedElementText(element, WEB_SNAPSHOT_MAX_ELEMENT_TEXT, budget);
        if (typeof accessibleName !== "string" && accessibleName.budgetExhausted) scanLimitReached = true;
        const preferredSemanticId = element.id || element.getAttribute("data-automation-id") || undefined;
        elements.push({
          semanticId: getWebBrowserSemanticRegistry(document).register(document, element, preferredSemanticId),
          role: element.getAttribute("role")?.slice(0, 128) || element.tagName.toLowerCase(),
          accessibleName: typeof accessibleName === "string" ? accessibleName : accessibleName.text,
          ...(("value" in element && typeof (element as HTMLInputElement).value === "string" &&
            !isCredentialValue(element))
            ? { value: (element as HTMLInputElement).value.slice(0, WEB_SNAPSHOT_MAX_ELEMENT_TEXT) }
            : {}),
          disabled: "disabled" in element && (element as HTMLButtonElement).disabled === true,
          bounds: { x: bounds.x, y: bounds.y, width: Math.max(0, bounds.width), height: Math.max(0, bounds.height) },
        });
      }
    }
    const children = node.childNodes;
    const childLimit = Math.min(children.length, Math.max(0, WEB_SNAPSHOT_MAX_SCAN_NODES - budget.visited - budget.pending));
    if (childLimit < children.length) scanLimitReached = true;
    for (let index = childLimit - 1; index >= 0; index -= 1) {
      if (!pushSnapshotNode(stack, children[index]!, budget)) {
        scanLimitReached = true;
        break;
      }
    }
  }
  const visibleText = textParts.join("").trim();
  return {
    visibleText,
    visibleTextTruncation: textTruncated || scanLimitReached
      ? { truncated: true, originalCount: Math.max(BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS + 1, visibleText.length + 1), reason: textTruncated ? "character-limit" : "entry-limit" }
      : { truncated: false },
    elements,
    elementsTruncation: elementCount > elements.length || scanLimitReached
      ? { truncated: true, originalCount: Math.max(elementCount, elements.length + 1), reason: "entry-limit" }
      : { truncated: false },
  };
}

function waitForLoad(
  dispatch: BrowserAutomationHostDispatch,
  iframe: WebIframe,
  signal: AbortSignal,
  startNavigation: () => void,
): Promise<BrowserAutomationResponse | null> {
  const aborted = checkAbort(dispatch, signal);
  if (aborted) return Promise.resolve(aborted);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(failure(dispatch, "DEADLINE_EXCEEDED", "Browser navigation timed out"));
    }, Math.max(1, dispatch.request.deadline - Date.now()));
    const onLoad = () => {
      cleanup();
      resolve(checkAbort(dispatch, signal));
    };
    const onAbort = () => {
      cleanup();
      resolve(failure(dispatch, "OPERATION_CANCELLED", "Browser operation was cancelled"));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      iframe.removeEventListener("load", onLoad);
      signal.removeEventListener("abort", onAbort);
    };
    iframe.addEventListener("load", onLoad, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      cleanup();
      resolve(failure(dispatch, "OPERATION_CANCELLED", "Browser operation was cancelled"));
      return;
    }
    try {
      startNavigation();
    } catch {
      cleanup();
      resolve(failure(dispatch, "NAVIGATION_FAILED", "Web Preview navigation failed"));
    }
  });
}

function snapshot(dispatch: BrowserAutomationHostDispatch, iframe: WebIframe, signal: AbortSignal): BrowserAutomationResponse {
  const document = currentDocument(iframe);
  if (!document) return failure(dispatch, "CROSS_ORIGIN", "Visible preview is cross-origin");
  const bounded = collectBoundedSnapshot(document);
  const cancelled = checkAbort(dispatch, signal);
  if (cancelled) return cancelled;
  return response(dispatch, {
    operation: "snapshot",
    snapshot: {
      url: document.location?.href || iframe.src || "about:blank",
      title: (document.title || "").slice(0, 4_096),
      loading: document.readyState !== "complete",
      visibleText: bounded.visibleText,
      visibleTextTruncation: bounded.visibleTextTruncation,
      elements: bounded.elements,
      elementsTruncation: bounded.elementsTruncation,
      accessibility: [],
      accessibilityTruncation: { truncated: false },
      console: [],
      consoleTruncation: { truncated: false },
      network: [],
      networkTruncation: { truncated: false },
      actions: [],
      actionsTruncation: { truncated: false },
    },
    controlEpoch: dispatch.request.expectedControlEpoch,
  });
}

async function inspect(dispatch: BrowserAutomationHostDispatch, iframe: WebIframe, signal: AbortSignal): Promise<BrowserAutomationResponse> {
  const observed = snapshot({ ...dispatch, request: { ...dispatch.request, operation: "snapshot", args: { includeScreenshot: false, timeoutMs: 15_000 } } } as BrowserAutomationHostDispatch, iframe, signal);
  if (!observed.ok) return observed;
  if (observed.result.operation !== "snapshot") return failure(dispatch, "UNSUPPORTED_OPERATION", "Web Preview snapshot response was invalid");
  const screenshotResult = dispatch.request.args.includeScreenshot
    ? await captureVisibleWebScreenshot({ iframe, maxWidth: BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH, deadline: dispatch.request.deadline, signal })
    : null;
  if (screenshotResult && !screenshotResult.ok) return failure(dispatch, screenshotResult.code === "TIMEOUT" ? "DEADLINE_EXCEEDED" : screenshotResult.code, "Web Preview screenshot failed");
  const mechanical: MechanicalInspectResult = {
    operation: "inspect",
    target: { threadId: dispatch.target.threadId, tabId: dispatch.target.tabId, targetGeneration: dispatch.target.targetGeneration, sticky: true },
    tabs: [dispatch.target],
    snapshot: observed.result.snapshot,
    ...(screenshotResult?.ok ? { screenshot: screenshotResult.value } : {}),
    ...(dispatch.request.args.includeDiagnostics ? { diagnostics: [] } : {}),
  };
  return response(dispatch, mechanical);
}

function screenshot(dispatch: BrowserAutomationHostDispatch, iframe: WebIframe, signal: AbortSignal): Promise<BrowserAutomationResponse> {
  const maxWidth = dispatch.request.operation === "screenshot" && typeof dispatch.request.args.maxWidth === "number"
    ? dispatch.request.args.maxWidth
    : BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH;
  return captureVisibleWebScreenshot({ iframe, maxWidth, deadline: dispatch.request.deadline, signal }).then((result) => {
    if (!result.ok) {
      const mapped = result.code === "TIMEOUT" ? "DEADLINE_EXCEEDED"
        : result.code;
      return failure(dispatch, mapped, `Web Preview screenshot failed: ${result.code}`);
    }
    const cancelled = checkAbort(dispatch, signal);
    if (cancelled) return cancelled;
    return response(dispatch, { operation: "screenshot", screenshot: result.value, controlEpoch: dispatch.request.expectedControlEpoch });
  });
}

/** Executes the bounded same-origin web Preview operations against its visible iframe. */
export async function executeWebBrowserDispatch(
  dispatch: BrowserAutomationHostDispatch,
  signal: AbortSignal,
): Promise<BrowserAutomationResponse> {
  const early = checkAbort(dispatch, signal);
  if (early) return early;
  const iframe = findIframe(dispatch);
  if (!iframe) return failure(dispatch, "TAB_UNAVAILABLE", "Visible web Preview target is unavailable");
  const { request } = dispatch;
  if (request.operation === "status") {
    const document = currentDocument(iframe);
    const mechanical: MechanicalStatusResult = {
      operation: "status",
      available: true,
      active: true,
      tabId: dispatch.target.tabId,
      url: document?.location?.href || iframe.src || "about:blank",
      loading: document?.readyState !== "complete",
      focused: true,
      viewport: { width: iframe.clientWidth || 1, height: iframe.clientHeight || 1 },
    };
    return response(dispatch, mechanical);
  }
  if (request.operation === "inspect") return inspect(dispatch, iframe, signal);
  if (request.operation === "navigate" || request.operation === "open") {
    const url = request.operation === "navigate" ? request.args.url : request.args.url;
    if (url) {
      if (!sameOrigin(url)) return failure(dispatch, "CROSS_ORIGIN", "Web Preview navigation must remain same-origin");
      const loadResult = await waitForLoad(dispatch, iframe, signal, () => {
        iframe.src = url;
      });
      if (loadResult) return { ...loadResult, requestId: request.requestId, sequence: request.sequence };
    }
    const document = currentDocument(iframe);
    if (!document) return failure(dispatch, "CROSS_ORIGIN", "Visible preview is cross-origin");
    return response(dispatch, {
      operation: request.operation,
      url: document.location?.href || iframe.src || "about:blank",
      title: (document.title || "").slice(0, 4_096),
      controlEpoch: request.expectedControlEpoch,
    });
  }
  if (request.operation === "snapshot") return snapshot(dispatch, iframe, signal);
  if (request.operation === "screenshot") {
    if (request.args.fullPage === true) {
      return failure(dispatch, "UNSUPPORTED_OPERATION", "Web automation does not support full-page screenshots");
    }
    return screenshot(dispatch, iframe, signal);
  }
  return failure(dispatch, "UNSUPPORTED_OPERATION", "Web automation supports status, open, navigate, snapshot, and screenshot");
}
