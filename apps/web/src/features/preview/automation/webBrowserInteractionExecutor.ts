import type {
  BrowserAutomationHostDispatch,
  BrowserAutomationResult,
  BrowserAutomationResponse,
  BrowserAutomationTarget,
} from "@mcode/contracts";
import { getWebBrowserSemanticRegistry } from "./webBrowserSemanticRegistry";

const MAX_TARGET_SCAN = 1_024;
const MAX_METADATA_CHARS = 2_048;
const SECRET_KEY = /^(?:access[_-]?token|api[_-]?key|auth|authorization|bearer|client[_-]?secret|code|cookie|credential|id[_-]?token|jwt|password|private[_-]?key|refresh[_-]?token|secret|session|session[_-]?id|signature|token)$/i;
const SECRET_TEXT = /\b(access[_-]?token|api[_-]?key|authorization|bearer|cookie|credential|password|refresh[_-]?token|secret|session[_-]?id|token)(\s*[:=]\s*)([^,;!?\r\n]{1,512}?)(?=\s*(?:[,;!?\r\n]|\.\s+|$))/gi;
const BEARER_TEXT = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT_TEXT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const JWT_VALUE_TEXT = /\b(access[_-]?token|api[_-]?key|authorization|bearer|cookie|credential|password|refresh[_-]?token|secret|session[_-]?id|token)\b(\s*[:=]\s*)(eyJ[^\s,;]+)/gi;
const OPAQUE_CREDENTIAL_FRAGMENT = /^(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/i;
const URL_TEXT = /\bhttps?:\/\/[^\s"'<>]+/gi;
const executorEvents = new WeakSet<Event>();

/** Current host-owned identity used to reject stale work before a mutation. */
export interface WebInteractionGuard {
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly expectedControlEpoch: number;
  readonly targetGeneration: number;
  readonly getControlEpoch: () => number;
  readonly getTargetGeneration: () => number;
}

/** Same-origin iframe lookup inputs for the low-level DOM executor. */
export interface WebInteractionTargetDocument {
  readonly document: Document;
  readonly url: string;
  readonly title: string;
}

/** Result of resolving one bounded browser target. */
export type WebTargetResolution =
  | { readonly ok: true; readonly element: HTMLElement }
  | { readonly ok: false; readonly code: "TARGET_NOT_FOUND" | "TAB_UNAVAILABLE"; readonly message: string };

function fail(code: "TARGET_NOT_FOUND" | "TAB_UNAVAILABLE", message: string): WebTargetResolution {
  return { ok: false, code, message };
}

function escapeSelector(value: string): string {
  const escape = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS?.escape;
  if (escape) return escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function isVisible(element: HTMLElement, ownerDocument: Document): boolean {
  if (!element.isConnected) return false;
  const view = ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isNativeControl(element: HTMLElement, ownerDocument: Document): boolean {
  const view = ownerDocument.defaultView;
  return [view?.HTMLButtonElement, view?.HTMLInputElement, view?.HTMLSelectElement, view?.HTMLTextAreaElement]
    .some((constructor) => typeof constructor === "function" && element instanceof constructor);
}

function cssTarget(ownerDocument: Document, selector: string): HTMLElement | null {
  if (selector.length > 4_096) return null;
  const matches = ownerDocument.querySelectorAll<HTMLElement>(selector);
  return matches.length === 1 ? matches[0] ?? null : null;
}

function semanticTarget(ownerDocument: Document, semanticId: string): HTMLElement | null {
  return ownerDocument.getElementById(semanticId) ??
    ownerDocument.querySelector<HTMLElement>(`[data-automation-id="${escapeSelector(semanticId)}"]`) ??
    getWebBrowserSemanticRegistry(ownerDocument).resolve(ownerDocument, semanticId);
}

function roleTarget(ownerDocument: Document, role: string, accessibleNameValue: string): HTMLElement | null {
  let scanned = 0;
  const matches: HTMLElement[] = [];
  for (const candidate of ownerDocument.querySelectorAll<HTMLElement>("button,input,select,textarea,[role]")) {
    if (++scanned > MAX_TARGET_SCAN) return null;
    const candidateRole = candidate.getAttribute("role") || candidate.localName?.toLowerCase();
    if (candidateRole === role && accessibleName(candidate) === accessibleNameValue) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] ?? null : null;
}

function coordinateTarget(ownerDocument: Document, x: number, y: number): HTMLElement | null {
  const { clientWidth, clientHeight } = ownerDocument.documentElement;
  if (x < 0 || y < 0 || x > clientWidth || y > clientHeight) return null;
  return ownerDocument.elementFromPoint(x, y) as HTMLElement | null;
}

function resolveTargetElement(ownerDocument: Document, target: BrowserAutomationTarget): HTMLElement | null {
  if ("cssSelector" in target) return cssTarget(ownerDocument, target.cssSelector);
  if ("semanticId" in target) return semanticTarget(ownerDocument, target.semanticId);
  if ("role" in target) return roleTarget(ownerDocument, target.role, target.accessibleName);
  return coordinateTarget(ownerDocument, target.x, target.y);
}

function isEnabled(element: HTMLElement, ownerDocument: Document): boolean {
  if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
  const tagName = element.localName?.toLowerCase();
  const nativeTag = tagName === "button" || tagName === "input" || tagName === "select" || tagName === "textarea";
  if (nativeTag && !isNativeControl(element, ownerDocument)) return false;
  return !nativeTag || !(element as HTMLElement & { disabled?: boolean }).disabled;
}

function accessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labels = labelledBy.split(/\s+/).slice(0, 16).map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "");
    const text = labels.join(" ").trim();
    if (text) return text;
  }
  return element.getAttribute("aria-label")?.trim() || element.textContent?.trim().slice(0, 512) || "";
}

/** Resolve a target using only bounded, explicit DOM targeting mechanics. */
export function resolveWebTarget(ownerDocument: Document, target: BrowserAutomationTarget): WebTargetResolution {
  try {
    const element = resolveTargetElement(ownerDocument, target);
    if (!element) return fail("TARGET_NOT_FOUND", "Browser target was not found");
    if (!isVisible(element, ownerDocument) || !isEnabled(element, ownerDocument)) return fail("TARGET_NOT_FOUND", "Browser target is not eligible");
    return { ok: true, element };
  } catch {
    return fail("TARGET_NOT_FOUND", "Browser target selector is invalid");
  }
}

function guardMutation(guard: WebInteractionGuard): void {
  if (guard.signal.aborted) throw new Error("Browser operation was cancelled");
  if (Date.now() >= guard.deadline) throw new Error("Browser operation deadline exceeded");
  if (guard.getTargetGeneration() !== guard.targetGeneration) throw new Error("Browser target generation is stale");
  if (guard.getControlEpoch() !== guard.expectedControlEpoch) throw new Error("Browser control epoch is stale");
}

function waitForInteractionFrame(ownerDocument: Document, guard: WebInteractionGuard): Promise<void> {
  guardMutation(guard);
  const view = ownerDocument.defaultView;
  if (!view || typeof view.requestAnimationFrame !== "function") {
    return Promise.resolve().then(() => guardMutation(guard));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let frameId: number | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      guard.signal.removeEventListener("abort", onAbort);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (frameId !== null && typeof view.cancelAnimationFrame === "function") view.cancelAnimationFrame(frameId);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = () => finish(new Error("Browser operation was cancelled"));
    guard.signal.addEventListener("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(() => finish(new Error("Browser operation deadline exceeded")), Math.max(0, guard.deadline - Date.now()));
    try {
      const scheduledFrame = view.requestAnimationFrame(() => {
        try {
          guardMutation(guard);
          finish();
        } catch (cause) {
          finish(cause);
        }
      });
      frameId = scheduledFrame;
      if (settled && typeof view.cancelAnimationFrame === "function") view.cancelAnimationFrame(scheduledFrame);
    } catch (cause) {
      finish(cause);
    }
    if (guard.signal.aborted) onAbort();
  });
}

function response(dispatch: BrowserAutomationHostDispatch, result: BrowserAutomationResult): BrowserAutomationResponse {
  return { contractVersion: dispatch.request.contractVersion, requestId: dispatch.request.requestId, sequence: dispatch.request.sequence, ok: true, result };
}

function pageMetadata(ownerDocument: Document): { readonly url: string; readonly title: string } {
  return {
    url: redactBrowserLocation(ownerDocument.location.href),
    title: redactBrowserText(ownerDocument.title),
  };
}

/** Redact credential-shaped text before exposing page metadata to the broker. */
export function redactBrowserText(value: unknown): string {
  return String(value ?? "")
    .replace(URL_TEXT, (candidate) => redactBrowserLocation(candidate))
    .replace(BEARER_TEXT, "Bearer [REDACTED]")
    .replace(JWT_VALUE_TEXT, (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`)
    .replace(JWT_TEXT, "[REDACTED]")
    .replace(SECRET_TEXT, (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`)
    .slice(0, MAX_METADATA_CHARS);
}

function redactSearchParams(url: URL): void {
  for (const key of url.searchParams.keys()) {
    if (SECRET_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
}

function decodedFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Preserve the opaque fragment when it is not valid URL encoding.
    return value;
  }
}

function redactFragment(url: URL): void {
  if (url.hash.length <= 1) return;
  const rawFragment = url.hash.slice(1);
  if (OPAQUE_CREDENTIAL_FRAGMENT.test(decodedFragment(rawFragment).trim())) {
    url.hash = "[REDACTED]";
  }
  const fragment = new URLSearchParams(rawFragment);
  let changed = false;
  for (const key of fragment.keys()) {
    if (!SECRET_KEY.test(key)) continue;
    fragment.set(key, "[REDACTED]");
    changed = true;
  }
  if (changed) url.hash = fragment.toString();
}

/** Redact credentials and secret query values from a bounded page location. */
export function redactBrowserLocation(value: unknown): string {
  const raw = String(value ?? "").slice(0, 8_192);
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = "";
      url.password = "";
      redactSearchParams(url);
      redactFragment(url);
      return url.toString().slice(0, MAX_METADATA_CHARS);
    }
    if (raw === "about:blank") return raw;
    return `${url.protocol}[REDACTED]`;
  } catch {
    return "about:blank";
  }
}

function isNativeSubmitControl(element: HTMLElement, ownerDocument: Document): element is HTMLInputElement {
  if (!isNativeControl(element, ownerDocument) || element.localName.toLowerCase() !== "input") return false;
  const type = (element.getAttribute("type") ?? "text").toLowerCase();
  return !["button", "checkbox", "color", "date", "datetime-local", "file", "hidden", "image", "month", "radio", "range", "reset", "submit", "time", "week"].includes(type);
}

interface RequestSubmitMonitor {
  readonly requested: () => boolean;
  readonly restore: () => void;
}

function monitorRequestSubmit(element: HTMLElement, ownerDocument: Document): RequestSubmitMonitor {
  const form = isNativeSubmitControl(element, ownerDocument) ? element.form : null;
  const originalRequestSubmit = form?.requestSubmit;
  if (!form || typeof originalRequestSubmit !== "function") {
    return { requested: () => false, restore: () => undefined };
  }
  let requested = false;
  const wrappedRequestSubmit = function(this: HTMLFormElement, submitter?: HTMLElement): void {
    requested = true;
    if (submitter === undefined) originalRequestSubmit.call(this);
    else originalRequestSubmit.call(this, submitter);
  };
  form.requestSubmit = wrappedRequestSubmit;
  return {
    requested: () => requested,
    restore: () => {
      if (form.requestSubmit === wrappedRequestSubmit) form.requestSubmit = originalRequestSubmit;
    },
  };
}

function dispatchKeyboardEvent(
  KeyboardEventConstructor: typeof KeyboardEvent,
  element: HTMLElement,
  type: "keydown" | "keypress" | "keyup",
  init: KeyboardEventInit,
): { allowed: boolean; prevented: boolean } {
  const event = new KeyboardEventConstructor(type, init);
  markExecutorEvent(event);
  return { allowed: element.dispatchEvent(event), prevented: event.defaultPrevented };
}

function dispatchEnter(ownerDocument: Document, element: HTMLElement): { readonly defaultAllowed: boolean; readonly formSubmitRequested: boolean } {
  const view = ownerDocument.defaultView;
  if (!view || typeof view.KeyboardEvent !== "function") throw new Error("Browser iframe event constructors are unavailable");
  const init = { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true } as const;
  const monitor = monitorRequestSubmit(element, ownerDocument);
  try {
    const keydown = dispatchKeyboardEvent(view.KeyboardEvent, element, "keydown", init);
    const keypress = keydown.allowed && !keydown.prevented
      ? dispatchKeyboardEvent(view.KeyboardEvent, element, "keypress", init)
      : { allowed: true, prevented: false };
    dispatchKeyboardEvent(view.KeyboardEvent, element, "keyup", init);
    return { defaultAllowed: keydown.allowed && !keydown.prevented && keypress.allowed, formSubmitRequested: monitor.requested() };
  } finally {
    monitor.restore();
  }
}

function errorResponse(dispatch: BrowserAutomationHostDispatch, code: Extract<BrowserAutomationResponse, { ok: false }>["error"]["code"], message: string): BrowserAutomationResponse {
  return { contractVersion: dispatch.request.contractVersion, requestId: dispatch.request.requestId, sequence: dispatch.request.sequence, ok: false, error: { code, message, retryable: code !== "INVALID_REQUEST" } };
}

function markExecutorEvent(event: Event): void {
  executorEvents.add(event);
}

type WebTypeRequest = Extract<BrowserAutomationHostDispatch["request"], { readonly operation: "type" }>;
type WebClickRequest = Extract<BrowserAutomationHostDispatch["request"], { readonly operation: "click" }>;

function editableTarget(element: HTMLElement, ownerDocument: Document): boolean {
  if (element.isContentEditable) return true;
  const tagName = element.localName?.toLowerCase();
  return (tagName === "input" || tagName === "textarea") && isNativeControl(element, ownerDocument);
}

function clearTypedValue(element: HTMLElement): void {
  if (element.isContentEditable) {
    element.textContent = "";
    return;
  }
  (element as HTMLInputElement | HTMLTextAreaElement).value = "";
}

function appendTypedValue(element: HTMLElement, text: string): void {
  if (element.isContentEditable) {
    element.textContent = `${element.textContent ?? ""}${text}`;
    return;
  }
  const input = element as HTMLInputElement | HTMLTextAreaElement;
  const value = `${input.value}${text}`;
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
  descriptor?.set?.call(input, value);
  if (!input.value.endsWith(text)) input.value = value;
}

function dispatchTextInputEvent(ownerDocument: Document, element: HTMLElement): void {
  const view = ownerDocument.defaultView;
  if (!view || typeof view.InputEvent !== "function" || typeof view.KeyboardEvent !== "function") {
    throw new Error("Browser iframe event constructors are unavailable");
  }
  const inputEvent = new view.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText" });
  markExecutorEvent(inputEvent);
  element.dispatchEvent(inputEvent);
}

function requestSubmitAfterEnter(
  ownerDocument: Document,
  element: HTMLElement,
  guard: WebInteractionGuard,
): void {
  const enter = dispatchEnter(ownerDocument, element);
  guardMutation(guard);
  if (!enter.defaultAllowed || enter.formSubmitRequested || !isNativeSubmitControl(element, ownerDocument)) return;
  const form = (element as HTMLInputElement).form;
  if (form && typeof form.requestSubmit === "function") form.requestSubmit();
}

async function executeTypeInput(
  ownerDocument: Document,
  element: HTMLElement,
  args: WebTypeRequest["args"],
  guard: WebInteractionGuard,
): Promise<void> {
  if (!editableTarget(element, ownerDocument)) throw new Error("Browser type target is not editable");
  await waitForInteractionFrame(ownerDocument, guard);
  guardMutation(guard);
  element.focus();
  if (args.clear) clearTypedValue(element);
  guardMutation(guard);
  appendTypedValue(element, args.text);
  dispatchTextInputEvent(ownerDocument, element);
  if (args.submit) {
    guardMutation(guard);
    requestSubmitAfterEnter(ownerDocument, element, guard);
  }
  guardMutation(guard);
}

function mouseButton(button: WebClickRequest["args"]["button"]): number {
  if (button === "right") return 2;
  return button === "middle" ? 1 : 0;
}

async function executeClickInput(
  ownerDocument: Document,
  element: HTMLElement,
  args: WebClickRequest["args"],
  guard: WebInteractionGuard,
): Promise<void> {
  await waitForInteractionFrame(ownerDocument, guard);
  guardMutation(guard);
  const view = ownerDocument.defaultView;
  if (!view || typeof view.MouseEvent !== "function") throw new Error("Browser iframe event constructors are unavailable");
  const button = mouseButton(args.button);
  for (let clickIndex = 0; clickIndex < args.clickCount; clickIndex += 1) {
    const init = { bubbles: true, cancelable: true, composed: true, button, detail: clickIndex + 1 };
    const mouseDown = new view.MouseEvent("mousedown", init);
    const mouseUp = new view.MouseEvent("mouseup", init);
    const click = new view.MouseEvent("click", init);
    markExecutorEvent(mouseDown);
    markExecutorEvent(mouseUp);
    markExecutorEvent(click);
    element.dispatchEvent(mouseDown);
    guardMutation(guard);
    element.dispatchEvent(mouseUp);
    guardMutation(guard);
    element.dispatchEvent(click);
    guardMutation(guard);
  }
}

function executionFailure(dispatch: BrowserAutomationHostDispatch, cause: unknown): BrowserAutomationResponse {
  const message = cause instanceof Error ? cause.message : "Browser operation failed";
  const classified = [
    ["deadline", "DEADLINE_EXCEEDED"],
    ["generation", "STALE_TARGET_GENERATION"],
    ["epoch", "STALE_CONTROL_EPOCH"],
    ["cancelled", "OPERATION_CANCELLED"],
  ] as const;
  const match = classified.find(([fragment]) => message.includes(fragment));
  return match
    ? errorResponse(dispatch, match[1], message)
    : errorResponse(dispatch, "TAB_UNAVAILABLE", "Browser target is unavailable");
}

/** True only for an event emitted by this executor instance. */
export function isExecutorGeneratedEvent(event: Event): boolean {
  return executorEvents.has(event);
}

/** True only for browser events carrying the platform's trusted-user signal. */
export function isTrustedHumanInputEvent(event: Event): boolean {
  return event.isTrusted === true;
}

/** Attach direct-user takeover observers to one same-origin document. */
export function observeWebHumanInput(
  ownerDocument: Document,
  onHumanInput: () => void,
  isTrustedInput: (event: Event) => boolean = isTrustedHumanInputEvent,
): () => void {
  const handler = (event: Event) => {
    if (isExecutorGeneratedEvent(event) || !isTrustedInput(event)) return;
    onHumanInput();
  };
  ownerDocument.addEventListener("pointerdown", handler, true);
  ownerDocument.addEventListener("keydown", handler, true);
  return () => {
    ownerDocument.removeEventListener("pointerdown", handler, true);
    ownerDocument.removeEventListener("keydown", handler, true);
  };
}

/** Execute bounded click/type mechanics against an already-authorized document. */
export async function executeWebInteraction(
  ownerDocument: Document,
  dispatch: BrowserAutomationHostDispatch,
  guard: WebInteractionGuard,
): Promise<BrowserAutomationResponse> {
  if (dispatch.request.operation !== "click" && dispatch.request.operation !== "type") {
    return errorResponse(dispatch, "UNSUPPORTED_OPERATION", "Web executor supports click and type only");
  }
  try {
    const target = dispatch.request.args.target;
    if (!target) return errorResponse(dispatch, "TARGET_NOT_FOUND", "Browser target was not specified");
    guardMutation(guard);
    const resolved = resolveWebTarget(ownerDocument, target);
    if (!resolved.ok) return errorResponse(dispatch, resolved.code, resolved.message);
    const element = resolved.element;
    if (dispatch.request.operation === "type") {
      await executeTypeInput(ownerDocument, element, dispatch.request.args, guard);
      return response(dispatch, { operation: "type", ...pageMetadata(ownerDocument), controlEpoch: guard.expectedControlEpoch });
    }
    await executeClickInput(ownerDocument, element, dispatch.request.args, guard);
    return response(dispatch, { operation: "click", ...pageMetadata(ownerDocument), controlEpoch: guard.expectedControlEpoch });
  } catch (cause) {
    return executionFailure(dispatch, cause);
  }
}

/** Resolve an iframe's same-origin document without weakening browser policy. */
export function resolveSameOriginFrame(frame: HTMLIFrameElement | null): WebInteractionTargetDocument | null {
  if (!frame) return null;
  try {
    const document = frame.contentDocument;
    if (!document || !frame.contentWindow || frame.contentWindow.location.origin !== window.location.origin) return null;
    return { document, url: document.location.href, title: document.title };
  } catch {
    return null;
  }
}
