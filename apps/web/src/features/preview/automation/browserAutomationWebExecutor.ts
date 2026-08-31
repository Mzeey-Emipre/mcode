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

function hasPermittedFrameOrigin(origin: string | undefined, frameUrl: string): boolean {
  if (origin && origin !== "null") return origin === window.location.origin;
  const frameAddress = new URL(frameUrl || "about:blank", window.location.href);
  return frameAddress.protocol === "about:" || frameAddress.origin === window.location.origin;
}

function currentDocument(iframe: WebIframe): Document | null {
  try {
    const document = iframe.contentDocument;
    if (!document) return null;
    return hasPermittedFrameOrigin(document.location?.origin, iframe.src) ? document : null;
  } catch {
    return null;
  }
}

function hasHiddenAttributes(element: Element): boolean {
  return element.hasAttribute("hidden") || element.hasAttribute("inert") || element.getAttribute("aria-hidden") === "true";
}

function hasHiddenInlineStyle(element: Element): boolean {
  const style = element.getAttribute("style") ?? "";
  return /display\s*:\s*none/i.test(style) || /visibility\s*:\s*(?:hidden|collapse)/i.test(style);
}

function hasHiddenComputedStyle(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const computed = view.getComputedStyle(element);
  return computed.display === "none" || computed.visibility === "hidden" || computed.visibility === "collapse";
}

function isHiddenElementSelf(element: Element): boolean {
  return hasHiddenAttributes(element) || hasHiddenInlineStyle(element) || hasHiddenComputedStyle(element);
}

function isSemanticElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  if (tagName === "input" && (element.getAttribute("type") ?? "").toLowerCase() === "hidden") return false;
  return tagName === "a" || tagName === "button" || tagName === "input" || tagName === "select" ||
    tagName === "textarea" || element.hasAttribute("role");
}

class BoundedElementTextCollector {
  private readonly parts: string[] = [];
  private readonly stack: SnapshotNode[] = [];
  private length = 0;
  private localVisited = 0;
  private localPending = 0;
  private budgetExhausted = false;

  public constructor(
    private readonly limit: number,
    private readonly budget: SnapshotBudget,
  ) {}

  public collect(element: Element): { text: string; budgetExhausted: boolean } {
    this.enqueueChildren(element.childNodes);
    while (this.canContinue()) this.visitNext();
    if (this.stack.length > 0) this.budgetExhausted = true;
    this.budget.pending -= this.localPending;
    return { text: this.parts.join("").trim().slice(0, this.limit), budgetExhausted: this.budgetExhausted };
  }

  private canContinue(): boolean {
    return this.stack.length > 0 && this.length < this.limit &&
      this.localVisited < WEB_SNAPSHOT_MAX_ELEMENT_TEXT_NODES &&
      this.budget.visited < WEB_SNAPSHOT_MAX_SCAN_NODES;
  }

  private push(node: Node): boolean {
    if (this.localVisited + this.localPending >= WEB_SNAPSHOT_MAX_ELEMENT_TEXT_NODES ||
      this.budget.visited + this.budget.pending >= WEB_SNAPSHOT_MAX_SCAN_NODES) return false;
    this.stack.push({ node, hidden: false });
    this.localPending += 1;
    this.budget.pending += 1;
    return true;
  }

  private pop(): SnapshotNode | undefined {
    const entry = this.stack.pop();
    if (!entry) return undefined;
    this.localPending -= 1;
    this.localVisited += 1;
    this.budget.pending -= 1;
    this.budget.visited += 1;
    return entry;
  }

  private enqueueChildren(children: NodeListOf<ChildNode> | NodeList): void {
    const childLimit = Math.min(
      children.length,
      Math.max(0, WEB_SNAPSHOT_MAX_ELEMENT_TEXT_NODES - this.localVisited - this.localPending),
      Math.max(0, WEB_SNAPSHOT_MAX_SCAN_NODES - this.budget.visited - this.budget.pending),
    );
    if (childLimit < children.length) this.budgetExhausted = true;
    for (let index = childLimit - 1; index >= 0; index -= 1) {
      if (!this.push(children[index]!)) {
        this.budgetExhausted = true;
        return;
      }
    }
  }

  private visitNext(): void {
    const entry = this.pop();
    if (!entry || entry.hidden) return;
    if (entry.node.nodeType === 3) {
      this.appendText(entry.node.nodeValue ?? "");
      return;
    }
    if (entry.node.nodeType !== 1 || isHiddenElementSelf(entry.node as Element)) return;
    this.enqueueChildren(entry.node.childNodes);
  }

  private appendText(value: string): void {
    const retained = value.slice(0, this.limit - this.length);
    this.parts.push(retained);
    this.length += retained.length;
  }
}

function boundedElementText(element: Element, limit: number, budget: SnapshotBudget): { text: string; budgetExhausted: boolean } {
  return new BoundedElementTextCollector(limit, budget).collect(element);
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

function snapshotElementValue(element: Element): string | undefined {
  if (!("value" in element) || typeof (element as HTMLInputElement).value !== "string") return undefined;
  if (isCredentialValue(element)) return undefined;
  return (element as HTMLInputElement).value.slice(0, WEB_SNAPSHOT_MAX_ELEMENT_TEXT);
}

function isSnapshotIgnoredElement(element: Element): boolean {
  return isHiddenElementSelf(element) || ["script", "style", "noscript", "template"].includes(element.tagName.toLowerCase());
}

function snapshotAccessibleName(
  element: Element,
  budget: SnapshotBudget,
): { value: string; budgetExhausted: boolean } {
  const label = element.getAttribute("aria-label")?.slice(0, WEB_SNAPSHOT_MAX_ELEMENT_TEXT);
  if (label) return { value: label, budgetExhausted: false };
  const { text, budgetExhausted } = boundedElementText(element, WEB_SNAPSHOT_MAX_ELEMENT_TEXT, budget);
  return { value: text, budgetExhausted };
}

function describeSnapshotElement(
  document: Document,
  element: Element,
  budget: SnapshotBudget,
): { entry: BoundedSnapshotData["elements"][number]; budgetExhausted: boolean } {
  const accessible = snapshotAccessibleName(element, budget);
  const bounds = (element as HTMLElement).getBoundingClientRect();
  const value = snapshotElementValue(element);
  const preferredId = element.id || element.getAttribute("data-automation-id") || undefined;
  return {
    entry: {
      semanticId: getWebBrowserSemanticRegistry(document).register(document, element, preferredId),
      role: element.getAttribute("role")?.slice(0, 128) || element.tagName.toLowerCase(),
      accessibleName: accessible.value,
      ...(value === undefined ? {} : { value }),
      disabled: "disabled" in element && (element as HTMLButtonElement).disabled === true,
      bounds: { x: bounds.x, y: bounds.y, width: Math.max(0, bounds.width), height: Math.max(0, bounds.height) },
    },
    budgetExhausted: accessible.budgetExhausted,
  };
}

class BoundedSnapshotCollector {
  private readonly elements: BoundedSnapshotData["elements"] = [];
  private readonly textParts: string[] = [];
  private readonly budget: SnapshotBudget = { visited: 0, pending: 0 };
  private readonly stack: SnapshotNode[] = [];
  private textLength = 0;
  private textTruncated = false;
  private elementCount = 0;
  private scanLimitReached = false;

  public constructor(private readonly document: Document) {}

  public collect(): BoundedSnapshotData {
    const root = this.document.body ?? this.document.documentElement;
    if (root && !pushSnapshotNode(this.stack, root, this.budget)) this.scanLimitReached = true;
    while (this.stack.length > 0 && this.budget.visited < WEB_SNAPSHOT_MAX_SCAN_NODES) {
      if (this.isComplete()) break;
      this.visit(popSnapshotNode(this.stack, this.budget)!);
    }
    return this.result();
  }

  private isComplete(): boolean {
    const textAtLimit = this.textTruncated || this.textLength >= BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS;
    if (!textAtLimit || this.elementCount <= BROWSER_AUTOMATION_MAX_ELEMENTS) return false;
    if (this.textLength >= BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS) this.textTruncated = true;
    return true;
  }

  private visit(entry: SnapshotNode): void {
    if (entry.hidden) return;
    if (entry.node.nodeType === 3) {
      this.appendText(entry.node.nodeValue ?? "");
      return;
    }
    if (entry.node.nodeType !== 1) return;
    const element = entry.node as Element;
    if (isSnapshotIgnoredElement(element)) return;
    if (isSemanticElement(element)) this.recordElement(element);
    this.enqueueChildren(entry.node.childNodes);
  }

  private appendText(value: string): void {
    if (!this.textTruncated && this.textLength < BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS) {
      const retained = value.slice(0, BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS - this.textLength);
      this.textParts.push(retained);
      this.textLength += retained.length;
      if (retained.length < value.length) this.textTruncated = true;
      return;
    }
    if (value.length > 0) this.textTruncated = true;
  }

  private recordElement(element: Element): void {
    this.elementCount += 1;
    if (this.elements.length >= BROWSER_AUTOMATION_MAX_ELEMENTS) return;
    const snapshot = describeSnapshotElement(this.document, element, this.budget);
    if (snapshot.budgetExhausted) this.scanLimitReached = true;
    this.elements.push(snapshot.entry);
  }

  private enqueueChildren(children: NodeListOf<ChildNode>): void {
    const limit = Math.min(children.length, Math.max(0, WEB_SNAPSHOT_MAX_SCAN_NODES - this.budget.visited - this.budget.pending));
    if (limit < children.length) this.scanLimitReached = true;
    for (let index = limit - 1; index >= 0; index -= 1) {
      if (!pushSnapshotNode(this.stack, children[index]!, this.budget)) {
        this.scanLimitReached = true;
        return;
      }
    }
  }

  private result(): BoundedSnapshotData {
    const visibleText = this.textParts.join("").trim();
    const visibleTextTruncation = this.textTruncated || this.scanLimitReached
      ? { truncated: true as const, originalCount: Math.max(BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS + 1, visibleText.length + 1), reason: this.textTruncated ? "character-limit" as const : "entry-limit" as const }
      : { truncated: false as const };
    const elementsTruncation = this.elementCount > this.elements.length || this.scanLimitReached
      ? { truncated: true as const, originalCount: Math.max(this.elementCount, this.elements.length + 1), reason: "entry-limit" as const }
      : { truncated: false as const };
    return { visibleText, visibleTextTruncation, elements: this.elements, elementsTruncation };
  }
}

function collectBoundedSnapshot(document: Document): BoundedSnapshotData {
  return new BoundedSnapshotCollector(document).collect();
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

type WebNavigationRequest = Extract<
  BrowserAutomationHostDispatch["request"],
  { readonly operation: "navigate" | "open" }
>;

function statusResponse(dispatch: BrowserAutomationHostDispatch, iframe: WebIframe): BrowserAutomationResponse {
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

function currentNavigationResponse(
  dispatch: BrowserAutomationHostDispatch,
  request: WebNavigationRequest,
  iframe: WebIframe,
): BrowserAutomationResponse {
  const document = currentDocument(iframe);
  if (!document) return failure(dispatch, "CROSS_ORIGIN", "Visible preview is cross-origin");
  return response(dispatch, {
    operation: request.operation,
    url: document.location?.href || iframe.src || "about:blank",
    title: (document.title || "").slice(0, 4_096),
    controlEpoch: request.expectedControlEpoch,
  });
}

async function navigateWebPreview(
  dispatch: BrowserAutomationHostDispatch,
  request: WebNavigationRequest,
  iframe: WebIframe,
  signal: AbortSignal,
): Promise<BrowserAutomationResponse> {
  const url = request.args.url;
  if (!url) return currentNavigationResponse(dispatch, request, iframe);
  if (!sameOrigin(url)) return failure(dispatch, "CROSS_ORIGIN", "Web Preview navigation must remain same-origin");
  const loadResult = await waitForLoad(dispatch, iframe, signal, () => {
    iframe.src = url;
  });
  if (loadResult) return { ...loadResult, requestId: request.requestId, sequence: request.sequence };
  return currentNavigationResponse(dispatch, request, iframe);
}

function executeScreenshot(
  dispatch: BrowserAutomationHostDispatch,
  iframe: WebIframe,
  signal: AbortSignal,
): Promise<BrowserAutomationResponse> {
  if (dispatch.request.operation === "screenshot" && dispatch.request.args.fullPage === true) {
    return Promise.resolve(failure(dispatch, "UNSUPPORTED_OPERATION", "Web automation does not support full-page screenshots"));
  }
  return screenshot(dispatch, iframe, signal);
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
  switch (dispatch.request.operation) {
    case "status":
      return statusResponse(dispatch, iframe);
    case "inspect":
      return inspect(dispatch, iframe, signal);
    case "navigate":
    case "open":
      return navigateWebPreview(dispatch, dispatch.request, iframe, signal);
    case "snapshot":
      return snapshot(dispatch, iframe, signal);
    case "screenshot":
      return executeScreenshot(dispatch, iframe, signal);
    default:
      return failure(dispatch, "UNSUPPORTED_OPERATION", "Web automation supports status, open, navigate, snapshot, and screenshot");
  }
}
