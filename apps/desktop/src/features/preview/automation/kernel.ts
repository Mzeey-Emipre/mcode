/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { BrowserWindow, nativeImage, type IpcMainInvokeEvent, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_AX_NODES,
  BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES,
  BROWSER_AUTOMATION_MAX_ELEMENTS,
  BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES,
  BROWSER_AUTOMATION_MAX_PENDING_REQUESTS,
  BROWSER_AUTOMATION_MAX_RESULT_BYTES,
  BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS,
  BrowserAutomationResponseSchema,
  BrowserAutomationHostDispatchSchema,
  type BrowserAutomationRequestOperation,
  type BrowserAutomationErrorCode,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserAutomationResult,
  type BrowserAutomationTarget,
  type BrowserAutomationHostDispatchTarget,
  type BrowserAutomationHostDispatch,
  type BrowserAutomationControllerState,
} from "@mcode/contracts";
import { findAdoptedWebContentsForWindow } from "../surfaces/registry.js";
import { resolveActivePreviewWebContentsForWindow } from "../surfaces/active-web-contents.js";
import { loadPreviewGuestUrl } from "../navigation/guest-navigation.js";
import { PREVIEW_GUEST_AGENT_INPUT_CHANNEL } from "../contracts/guest-input.js";
import { getSession, getThreadTabSet } from "../state/window-session.js";
import {
  BrowserAutomationCancelledError,
  BrowserAutomationQueueFullError,
  BrowserAutomationScheduler,
} from "./scheduler.js";
import { OldestFirstRingBuffer } from "./ring-buffer.js";
import { redactBrowserDiagnosticUrl, redactBrowserLocation, redactBrowserText, redactBrowserValue } from "./redaction.js";
import { updateBrowserAutomationAgentOperationDepth } from "./active-operation.js";

const EVALUATION_LIMIT = BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES;
const SCREENSHOT_BINARY_LIMIT = 360 * 1_024;
const SNAPSHOT_RESPONSE_BUDGET = BROWSER_AUTOMATION_MAX_RESULT_BYTES - 8 * 1_024;
const SNAPSHOT_STRUCTURED_BUDGET_WITH_IMAGE = 256 * 1_024;
const TARGET_GENERATION_TOMBSTONE_LIMIT = 128;

/** Exact renderer-owned target selected for one browser automation request. */
export type BrowserAutomationIpcTarget = BrowserAutomationHostDispatchTarget;

/** Validated IPC input accepted by the browser automation kernel. */
export type BrowserAutomationIpcRequest = BrowserAutomationHostDispatch;

type KernelErrorEffect = "none" | "created" | "closed" | "preserved" | "unknown";

class KernelError extends Error {
  constructor(
    readonly code: BrowserAutomationErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly effect: KernelErrorEffect = "none",
  ) {
    super(message);
    this.name = "BrowserAutomationKernelError";
  }
}

interface ConsoleEntry {
  timestamp: number;
  level: "debug" | "info" | "warning" | "error";
  text: string;
  sourceUrl?: string;
  line?: number;
}

interface NetworkEntry {
  timestamp: number;
  url: string;
  method: string;
  status?: number;
  failed: boolean;
  errorText?: string;
}

interface ActionEntry {
  timestamp: number;
  operation: BrowserAutomationRequestOperation;
  outcome: "started" | "succeeded" | "failed" | "interrupted";
  detail?: string;
}

interface TargetState {
  readonly key: string;
  readonly windowId: number;
  readonly threadId: string;
  readonly tabId: string;
  webContents: WebContents;
  targetGeneration: number;
  semanticGeneration: number;
  capabilityRevision: number;
  controlEpoch: number;
  controller: BrowserAutomationControllerState;
  syntheticInputDepth: number;
  syntheticInputUntil: number;
  guestInputGeneration: number;
  heldKeys: Set<string>;
  automationNavigationDepth: number;
  navigationSequence: number;
  debuggerOwned: boolean;
  diagnosticsReady: boolean;
  diagnosticListenerReady: boolean;
  isolatedContextId: number | null;
  networkRequests: Map<string, { url: string; method: string }>;
  console: OldestFirstRingBuffer<ConsoleEntry>;
  network: OldestFirstRingBuffer<NetworkEntry>;
  actions: OldestFirstRingBuffer<ActionEntry>;
  dispose: () => void;
}

type MechanicalInspectResult = Omit<Extract<BrowserAutomationResult, { operation: "inspect" }>, "readiness" | "observationRef" | "capabilities" | "guidance" | "capabilityRevision">;
type MechanicalStatusResult = Omit<Extract<BrowserAutomationResult, { operation: "status" }>, "capabilities" | "capabilityRevision">;

interface ResolvedTarget {
  state: TargetState;
  webContents: WebContents;
  window: BrowserWindow;
}

interface RendererOperationLease {
  readonly sender: WebContents;
  readonly requestId: string;
  readonly complete: (succeeded: boolean) => void;
}

interface GuestInputAllowanceHandle {
  readonly token: string;
  readonly generation: number;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function targetKey(windowId: number, threadId: string, tabId: string): string {
  return JSON.stringify([windowId, threadId, tabId]);
}

function assertShortId(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new KernelError("INVALID_REQUEST", `${name} must be a non-empty bounded string`, false);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function createAbortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new BrowserAutomationCancelledError());
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason instanceof Error ? signal.reason : new BrowserAutomationCancelledError()),
      { once: true },
    );
  });
}

async function boundedRace<T>(promise: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new KernelError("DEADLINE_EXCEEDED", "Browser operation deadline elapsed", true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      createAbortPromise(signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new KernelError("TIMEOUT", "Browser operation timed out", true)),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Captures bounded semantic page data inside the dedicated automation isolated world. */
export function snapshotPage(argument: { semanticGeneration: number; maxElements: number; maxText: number }) {
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit") return "button";
      return "textbox";
    }
    return "generic";
  };
  const nameOf = (element: Element): string => {
    const labelled = element.getAttribute("aria-label") ?? element.getAttribute("alt") ?? element.getAttribute("title");
    if (labelled) return labelled.trim().slice(0, 1024);
    const labelId = element.getAttribute("aria-labelledby");
    if (labelId) {
      const text = labelId.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      if (text) return text.slice(0, 1024);
    }
    if (element instanceof HTMLInputElement && element.labels?.length) {
      return [...element.labels].map((label) => label.textContent ?? "").join(" ").trim().slice(0, 1024);
    }
    return (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1024);
  };
  const hasSensitiveValue = (element: Element): boolean => {
    const input = element as HTMLInputElement;
    if ((input.type || element.getAttribute("type") || "").toLowerCase() === "password") return true;
    const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
    if (/\b(?:current-password|new-password|one-time-code|cc-number|cc-csc)\b/.test(autocomplete)) return true;
    const identity = [
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
    ].filter(Boolean).join(" ").toLowerCase();
    return /\b(?:password|passwd|passcode|secret|token|api[_ -]?key|auth(?:entication|orization)?|credential|one[_ -]?time[_ -]?code|otp|cvc|cvv|card[_ -]?number)\b/.test(identity);
  };
  const nodeList = document.querySelectorAll("a[href],button,input,textarea,select,[role],[tabindex]");
  const scanLimit = Math.min(nodeList.length, argument.maxElements * 10);
  const candidates: Element[] = [];
  for (let index = 0; index < scanLimit && candidates.length <= argument.maxElements; index += 1) {
    const element = nodeList.item(index);
    if (element && visible(element)) candidates.push(element);
  }
  const isolatedGlobal = globalThis as typeof globalThis & {
    __mcodeBrowserElements?: {
      byElement: WeakMap<Element, string>;
      byId: Map<string, Element>;
      sequence: number;
    };
  };
  const registry = isolatedGlobal.__mcodeBrowserElements ??= {
    byElement: new WeakMap<Element, string>(),
    byId: new Map<string, Element>(),
    sequence: 0,
  };
  for (const [id, element] of registry.byId) {
    if (!element.isConnected) registry.byId.delete(id);
  }
  const elements = candidates.slice(0, argument.maxElements).map((element) => {
    const rect = element.getBoundingClientRect();
    const input = element as HTMLInputElement;
    let semanticId = registry.byElement.get(element);
    if (!semanticId) {
      registry.sequence += 1;
      const randomPart = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${registry.sequence.toString(36)}`;
      semanticId = `e-${argument.semanticGeneration}-${randomPart}`;
      registry.byElement.set(element, semanticId);
      registry.byId.set(semanticId, element);
    }
    return {
      semanticId,
      role: roleOf(element).slice(0, 128),
      accessibleName: nameOf(element),
      value: hasSensitiveValue(element)
        ? "[REDACTED]"
        : typeof input.value === "string"
          ? input.value.slice(0, 1024)
          : undefined,
      disabled: "disabled" in input ? Boolean(input.disabled) : element.getAttribute("aria-disabled") === "true",
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
  const textParts: string[] = [];
  let textLength = 0;
  let scannedTextNodes = 0;
  let textTruncated = false;
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (scannedTextNodes < 10_000) {
      const node = walker.nextNode();
      if (!node) break;
      scannedTextNodes += 1;
      const parent = node.parentElement;
      if (!parent || !visible(parent)) continue;
      const part = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!part) continue;
      const separatorLength = textParts.length > 0 ? 1 : 0;
      const remaining = argument.maxText - textLength - separatorLength;
      if (remaining <= 0) { textTruncated = true; break; }
      textParts.push(part.slice(0, remaining));
      textLength += separatorLength + Math.min(part.length, remaining);
      if (part.length > remaining) { textTruncated = true; break; }
    }
    if (scannedTextNodes >= 10_000) textTruncated = true;
  }
  const text = textParts.join(" ").slice(0, argument.maxText);
  return {
    url: location.href,
    title: document.title,
    loading: document.readyState !== "complete",
    visibleText: text.slice(0, argument.maxText),
    visibleTextOriginalLength: text.length + (textTruncated ? 1 : 0),
    elements,
    elementCount: nodeList.length > scanLimit || candidates.length > argument.maxElements
      ? argument.maxElements + 1
      : candidates.length,
  };
}

/** Resolves one target to attachment, visibility, and action-point state inside the isolated world. */
export function inspectPageTarget(argument: { target: BrowserAutomationTarget; scrollIntoView?: boolean }) {
  const nodeList = document.querySelectorAll("a[href],button,input,textarea,select,[role],[tabindex]");
  const candidates: Element[] = [];
  for (let index = 0; index < Math.min(nodeList.length, 2_000); index += 1) {
    const element = nodeList.item(index);
    if (element) candidates.push(element);
  }
  const nameOf = (element: Element): string => {
    const labelled = element.getAttribute("aria-label") ?? element.getAttribute("alt") ?? element.getAttribute("title");
    if (labelled) return labelled.trim().slice(0, 1024);
    const labelId = element.getAttribute("aria-labelledby");
    if (labelId) {
      const text = labelId.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      if (text) return text.slice(0, 1024);
    }
    if (element instanceof HTMLInputElement && element.labels?.length) {
      return [...element.labels].map((label) => label.textContent ?? "").join(" ").trim().slice(0, 1024);
    }
    return (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1024);
  };
  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit") return "button";
      return "textbox";
    }
    return "generic";
  };
  let found: Element | null = null;
  if ("semanticId" in argument.target) {
    const isolatedGlobal = globalThis as typeof globalThis & {
      __mcodeBrowserElements?: { byId: Map<string, Element> };
    };
    found = isolatedGlobal.__mcodeBrowserElements?.byId.get(argument.target.semanticId) ?? null;
    if (found && !found.isConnected) {
      isolatedGlobal.__mcodeBrowserElements?.byId.delete(argument.target.semanticId);
      found = null;
    }
  } else if ("role" in argument.target) {
    const roleTarget = argument.target;
    const matches = candidates.filter(
      (element) => roleOf(element) === roleTarget.role && nameOf(element) === roleTarget.accessibleName,
    );
    if (matches.length !== 1) return { attached: false, visible: false };
    found = matches[0] ?? null;
  } else if ("cssSelector" in argument.target) {
    try {
      const matches = document.querySelectorAll(argument.target.cssSelector);
      if (matches.length !== 1) return { attached: false, visible: false };
      found = matches[0];
    } catch {
      return { attached: false, visible: false };
    }
  } else {
    return {
      attached: true,
      visible:
        argument.target.x >= 0 &&
        argument.target.y >= 0 &&
        argument.target.x <= innerWidth &&
        argument.target.y <= innerHeight,
      x: argument.target.x,
      y: argument.target.y,
    };
  }
  if (!found) return { attached: false, visible: false };
  let rect = found.getBoundingClientRect();
  if (
    argument.scrollIntoView &&
    (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight)
  ) {
    found.scrollIntoView({ block: "center", inline: "center" });
    rect = found.getBoundingClientRect();
  }
  const style = getComputedStyle(found);
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const isVisible =
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    (!argument.scrollIntoView || (
      point.x >= 0 &&
      point.y >= 0 &&
      point.x <= innerWidth &&
      point.y <= innerHeight
    ));
  return {
    attached: true,
    visible: isVisible,
    ...(isVisible ? point : {}),
  };
}

/** Resolves one target to its exact DOM element inside the isolated world. */
export function resolvePageTargetElement(target: BrowserAutomationTarget): Element | null {
  const nodeList = document.querySelectorAll("a[href],button,input,textarea,select,[role],[tabindex]");
  const candidates: Element[] = [];
  for (let index = 0; index < Math.min(nodeList.length, 2_000); index += 1) {
    const element = nodeList.item(index);
    if (element) candidates.push(element);
  }
  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit") return "button";
      return "textbox";
    }
    return "generic";
  };
  const nameOf = (element: Element): string => {
    const labelled = element.getAttribute("aria-label") ?? element.getAttribute("alt") ?? element.getAttribute("title");
    if (labelled) return labelled.trim().slice(0, 1_024);
    const labelId = element.getAttribute("aria-labelledby");
    if (labelId) {
      const text = labelId.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      if (text) return text.slice(0, 1_024);
    }
    if (element instanceof HTMLInputElement && element.labels?.length) {
      return [...element.labels].map((label) => label.textContent ?? "").join(" ").trim().slice(0, 1_024);
    }
    return (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1_024);
  };
  if ("semanticId" in target) {
    const registry = (globalThis as typeof globalThis & {
      __mcodeBrowserElements?: { byId: Map<string, Element> };
    }).__mcodeBrowserElements;
    const element = registry?.byId.get(target.semanticId) ?? null;
    if (!element?.isConnected) {
      registry?.byId.delete(target.semanticId);
      return null;
    }
    return element;
  }
  if ("role" in target) {
    const matches = candidates.filter(
      (element) => roleOf(element) === target.role && nameOf(element) === target.accessibleName,
    );
    return matches.length === 1 ? matches[0] ?? null : null;
  }
  if ("cssSelector" in target) {
    try {
      const matches = document.querySelectorAll(target.cssSelector);
      return matches.length === 1 ? matches[0] : null;
    } catch {
      return null;
    }
  }
  return document.elementFromPoint(target.x, target.y);
}

/** Captures bounded navigation, resource, long-task, and heap data inside the isolated world. */
export function capturePagePerformance(_argument: null) {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const resources = performance.getEntriesByType("resource").slice(0, 5_000) as PerformanceResourceTiming[];
  const longTasks = performance.getEntriesByType("longtask").slice(0, 5_000);
  let transferBytes = 0;
  let decodedBodyBytes = 0;
  let totalBlockingTimeMs = 0;
  for (const resource of resources) {
    transferBytes += Number(resource.transferSize) || 0;
    decodedBodyBytes += Number(resource.decodedBodySize) || 0;
  }
  for (const task of longTasks) {
    totalBlockingTimeMs += Math.max(0, (Number(task.duration) || 0) - 50);
  }
  const memory = (performance as Performance & {
    memory?: { jsHeapSizeLimit?: number };
  }).memory;
  return {
    navigation: navigation
      ? {
          ttfb: navigation.responseStart,
          dcl: navigation.domContentLoadedEventEnd,
          load: navigation.loadEventEnd,
        }
      : null,
    resources: { count: resources.length, transferBytes, decodedBodyBytes },
    longTasks: { count: longTasks.length, totalBlockingTimeMs },
    jsHeapLimitBytes: Number(memory?.jsHeapSizeLimit) || 0,
  };
}

/** Evaluates and serializes a bounded expression result inside the dedicated isolated world. */
export function evaluateIsolatedExpression(argument: {
  expression: string;
  awaitPromise: boolean;
  maxBytes: number;
}) {
  const secretKey = /^(?:access[_-]?token|api[_-]?key|auth|authorization|bearer|code|cookie|jwt|password|refresh[_-]?token|secret|session|token)$/i;
  const secretText = /\b(?:authorization|bearer|cookie|password|secret|token)\b\s*[:=]\s*([^\s,;]+)/gi;
  const opaqueSecrets = new Set<string>();
  const retainSecret = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const bounded = candidate.slice(0, 4_096);
    if (bounded.length >= 4) opaqueSecrets.add(bounded);
  };
  try {
    const cookieText = typeof document === "undefined" ? "" : document.cookie;
    retainSecret(cookieText);
    for (const cookie of cookieText.split(";").slice(0, 200)) {
      retainSecret(cookie.trim());
      retainSecret(cookie.slice(cookie.indexOf("=") + 1).trim());
    }
  } catch {
    // Pages can deny cookie access. Evaluation remains available with the
    // structural redaction policy below.
  }
  for (const storage of [
    typeof localStorage === "undefined" ? null : localStorage,
    typeof sessionStorage === "undefined" ? null : sessionStorage,
  ]) {
    if (!storage) continue;
    try {
      const entryCount = Math.min(storage.length, 200);
      for (let index = 0; index < entryCount; index += 1) {
        const key = storage.key(index);
        if (key === null) continue;
        retainSecret(storage.getItem(key));
      }
    } catch {
      // Sandboxed or opaque origins can deny storage access.
    }
  }
  const seen = new WeakSet<object>();
  let remainingNodes = 1_000;
  const sanitize = (value: unknown, depth: number): unknown => {
    remainingNodes -= 1;
    if (remainingNodes < 0 || depth > 8) return "[TRUNCATED]";
    if (typeof value === "string") {
      let redacted = value;
      for (const secret of opaqueSecrets) {
        if (redacted.includes(secret)) redacted = redacted.split(secret).join("[REDACTED]");
      }
      return redacted.replace(secretText, (match, captured: string) => match.replace(captured, "[REDACTED]")).slice(0, 4_096);
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "undefined") return null;
    if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
    if (typeof value !== "object") return null;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitize(item, depth + 1));
    const output: Record<string, unknown> = {};
    let retained = 0;
    for (const key in value as Record<string, unknown>) {
      if (retained >= 200 || remainingNodes <= 0) break;
      output[key] = secretKey.test(key)
        ? "[REDACTED]"
        : sanitize((value as Record<string, unknown>)[key], depth + 1);
      retained += 1;
    }
    return output;
  };
  const serialize = (value: unknown) => {
    const valueJson = JSON.stringify(sanitize(value, 0));
    if (new TextEncoder().encode(valueJson).byteLength > argument.maxBytes) {
      return { ok: false, tooLarge: true };
    }
    return { ok: true, valueJson };
  };
  const value = globalThis.eval(argument.expression) as unknown;
  return argument.awaitPromise ? Promise.resolve(value).then(serialize) : serialize(value);
}

/** Returns the native Select All modifier mask used by Chromium input events. */
export function selectAllModifierMask(platform: NodeJS.Platform = process.platform): number {
  return platform === "darwin" ? 4 : 2;
}

/** Executes bounded, serial browser operations against exact visible Electron webviews. */
export class BrowserAutomationKernel {
  private readonly scheduler = new BrowserAutomationScheduler(5, BROWSER_AUTOMATION_MAX_PENDING_REQUESTS);
  private readonly targets = new Map<string, TargetState>();
  private readonly targetGenerations = new Map<string, number>();
  private readonly cancellations = new Map<string, { cancel: () => void }>();
  private readonly subscribers = new Map<number, Set<(state: unknown) => void>>();
  private readonly rendererOperationLeases = new Map<string, RendererOperationLease>();

  /** Validates and executes one request from a trusted renderer. */
  async execute(event: IpcMainInvokeEvent, input: unknown): Promise<BrowserAutomationResponse> {
    let request: BrowserAutomationRequest | null = null;
    let cancellation: { cancel: () => void } | null = null;
    let resolved: ResolvedTarget | null = null;
    try {
      const parsedInput = this.parseInput(input);
      request = parsedInput.request;
      if (this.cancellations.has(request.requestId)) {
        throw new KernelError("INVALID_REQUEST", "Browser request id is already active", false);
      }
      const target = this.resolveTarget(event, parsedInput.request.threadId, parsedInput.target);
      resolved = target;
      const scheduled = this.scheduler.enqueue(target.state.key, (signal) =>
        this.runOperation(target, parsedInput.request, signal),
      );
      cancellation = { cancel: scheduled.cancel };
      this.cancellations.set(request.requestId, cancellation);
      const result = await scheduled.promise;
      const response = {
        contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
        requestId: request.requestId,
        sequence: request.sequence,
        ok: true as const,
        result,
      };
      const validated = BrowserAutomationResponseSchema().safeParse(response);
      if (!validated.success) {
        const firstIssue = validated.error.issues[0];
        const issue = firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "unknown validation failure";
        throw new KernelError("RESULT_TOO_LARGE", `Browser result failed contract validation: ${issue}`, false);
      }
      return validated.data;
    } catch (cause) {
      return this.failureResponse(request, cause);
    } finally {
      if (request) {
        const active = this.cancellations.get(request.requestId);
        if (active === cancellation) this.cancellations.delete(request.requestId);
      }
      if (resolved) this.restoreActivePreviewGuestFocus(resolved);
    }
  }

  /** Acquires the target scheduler and control epoch for a renderer-owned operation. */
  async beginRendererOperation(
    event: IpcMainInvokeEvent,
    input: unknown,
  ): Promise<{ ok: true; leaseId: string } | { ok: false; response: BrowserAutomationResponse }> {
    let request: BrowserAutomationRequest | null = null;
    try {
      const parsedInput = this.parseInput(input);
      request = parsedInput.request;
      if (
        request.operation !== "resize" &&
        request.operation !== "recordingStart" &&
        request.operation !== "recordingStop"
      ) {
        throw new KernelError("INVALID_REQUEST", "Operation does not require a renderer lease", false);
      }
      if (this.cancellations.has(request.requestId)) {
        throw new KernelError("INVALID_REQUEST", "Browser request id is already active", false);
      }
      const resolved = this.resolveTarget(event, request.threadId, parsedInput.target);
      const leaseId = randomUUID();
      let resolveReady!: (value: { ok: true; leaseId: string } | { ok: false; response: BrowserAutomationResponse }) => void;
      const ready = new Promise<{ ok: true; leaseId: string } | { ok: false; response: BrowserAutomationResponse }>((resolve) => {
        resolveReady = resolve;
      });
      let resolveCompletion!: (succeeded: boolean) => void;
      const completion = new Promise<boolean>((resolve) => {
        resolveCompletion = resolve;
      });
      let started = false;
      const scheduled = this.scheduler.enqueue(resolved.state.key, async (signal) => {
        const { state, webContents } = resolved;
        if (webContents.isDestroyed()) throw new KernelError("TAB_UNAVAILABLE", "Browser tab was closed", true);
        if (request!.expectedControlEpoch !== state.controlEpoch) {
          throw new KernelError("STALE_CONTROL_EPOCH", `Control epoch is stale; current epoch is ${state.controlEpoch}`, true);
        }
        if (request!.deadline <= Date.now()) {
          throw new KernelError("DEADLINE_EXCEEDED", "Browser operation deadline elapsed", true);
        }
        started = true;
        state.actions.push({ timestamp: Date.now(), operation: request!.operation, outcome: "started" });
        this.emitController(state, "agent", request!);
        this.rendererOperationLeases.set(leaseId, {
          sender: event.sender,
          requestId: request!.requestId,
          complete: resolveCompletion,
        });
        resolveReady({ ok: true, leaseId });
        try {
          const succeeded = await boundedRace(completion, signal, request!.deadline);
          state.actions.push({
            timestamp: Date.now(),
            operation: request!.operation,
            outcome: succeeded ? "succeeded" : "failed",
          });
        } finally {
          this.rendererOperationLeases.delete(leaseId);
        }
      });
      const cancellation = { cancel: scheduled.cancel };
      this.cancellations.set(request.requestId, cancellation);
      void scheduled.promise.catch((cause) => {
        if (!started) resolveReady({ ok: false, response: this.failureResponse(request, cause) });
      }).finally(() => {
        this.rendererOperationLeases.delete(leaseId);
        if (this.cancellations.get(request!.requestId) === cancellation) {
          this.cancellations.delete(request!.requestId);
        }
      });
      return await ready;
    } catch (cause) {
      return { ok: false, response: this.failureResponse(request, cause) };
    }
  }

  /** Releases one exact renderer operation lease after local work settles. */
  finishRendererOperation(event: IpcMainInvokeEvent, input: unknown): boolean {
    const value = asRecord(input);
    let leaseId: string;
    try {
      leaseId = assertShortId(value.leaseId, "leaseId");
    } catch {
      return false;
    }
    if (typeof value.succeeded !== "boolean") return false;
    const lease = this.rendererOperationLeases.get(leaseId);
    if (!lease || lease.sender !== event.sender) return false;
    this.rendererOperationLeases.delete(leaseId);
    lease.complete(value.succeeded);
    return true;
  }

  /** Cancels one request by its opaque identifier. */
  cancel(requestId: unknown): boolean {
    let id: string;
    try {
      id = assertShortId(requestId, "requestId");
    } catch {
      return false;
    }
    const cancellation = this.cancellations.get(id);
    if (!cancellation) return false;
    cancellation.cancel();
    return true;
  }

  /** Transfers control to the human and interrupts queued work for an exact target. */
  interrupt(event: IpcMainInvokeEvent, target: unknown): boolean {
    const input = asRecord(target);
    let threadId: string;
    let tabId: string;
    try {
      threadId = assertShortId(input.threadId, "threadId");
      tabId = assertShortId(input.tabId, "tabId");
    } catch {
      return false;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    const state = this.targets.get(targetKey(win.id, threadId, tabId));
    if (!state) return false;
    if (state.controller.controller === "human") return false;
    this.humanInterrupt(state);
    return true;
  }

  /** Releases retained agent presentation after its owning turn completes. */
  releaseAgentControl(event: IpcMainInvokeEvent, target: unknown): boolean {
    const input = asRecord(target);
    let threadId: string;
    let tabId: string;
    let providerSessionId: string;
    try {
      threadId = assertShortId(input.threadId, "threadId");
      tabId = assertShortId(input.tabId, "tabId");
      providerSessionId = assertShortId(input.providerSessionId, "providerSessionId");
    } catch {
      return false;
    }
    if (!Number.isInteger(input.controlEpoch) || (input.controlEpoch as number) < 0) return false;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    const state = this.targets.get(targetKey(win.id, threadId, tabId));
    if (
      !state ||
      state.controller.controller !== "agent" ||
      state.controlEpoch !== input.controlEpoch ||
      state.controller.providerSessionId !== providerSessionId
    ) return false;
    this.emitController(state, "none");
    this.restoreActivePreviewGuestFocus({ state, webContents: state.webContents, window: win });
    return true;
  }

  /** Describes the exact renderer-owned browser target without exposing WebContents details. */
  describeTarget(
    event: IpcMainInvokeEvent,
    input: unknown,
  ):
    | { ok: true; target: { windowId: number; threadId: string; tabId: string; targetGeneration: number; active: boolean; focused: boolean; lastUsedAt: number } }
    | { ok: false; error: string } {
    const record = asRecord(input);
    let threadId: string;
    let tabId: string;
    try {
      threadId = assertShortId(record.threadId, "threadId");
      tabId = assertShortId(record.tabId, "tabId");
    } catch {
      return { ok: false, error: "invalid-target" };
    }
    try {
      const resolved = this.resolveCurrentTarget(event, threadId, tabId);
      const tabSet = getThreadTabSet(getSession(resolved.window), threadId);
      const tab = tabSet?.tabs.find((candidate) => candidate.id === tabId);
      return {
        ok: true,
        target: {
          windowId: resolved.state.windowId,
          threadId,
          tabId,
          targetGeneration: resolved.state.targetGeneration,
          active: tabSet?.activeTabId === tabId,
          focused: resolved.webContents.isFocused(),
          lastUsedAt: Math.max(0, Math.round(tab?.lastActiveAt ?? 0)),
        },
      };
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof KernelError ? cause.code : "TAB_UNAVAILABLE",
      };
    }
  }

  /** Issues a short-lived tab capture id for one exact adopted preview guest. */
  getMediaSourceId(
    event: IpcMainInvokeEvent,
    input: unknown,
  ):
    | { ok: true; mediaSourceId: string; expiresAt: number }
    | { ok: false; error: string } {
    const target = asRecord(input);
    let threadId: string;
    let tabId: string;
    try {
      threadId = assertShortId(target.threadId, "threadId");
      tabId = assertShortId(target.tabId, "tabId");
    } catch {
      return { ok: false, error: "INVALID_REQUEST" };
    }
    if (
      !Number.isInteger(target.windowId) || Number(target.windowId) <= 0 ||
      !Number.isInteger(target.targetGeneration) || Number(target.targetGeneration) < 0
    ) {
      return { ok: false, error: "INVALID_REQUEST" };
    }
    try {
      const resolved = this.resolveCurrentTarget(event, threadId, tabId);
      if (
        resolved.state.windowId !== target.windowId ||
        resolved.state.targetGeneration !== target.targetGeneration
      ) {
        throw new KernelError("STALE_TARGET_GENERATION", "Browser target changed before capture", true);
      }
      return {
        ok: true,
        mediaSourceId: resolved.webContents.getMediaSourceId(event.sender),
        expiresAt: Date.now() + 10_000,
      };
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof KernelError ? cause.code : "TAB_UNAVAILABLE",
      };
    }
  }

  /** Transfers control to the human and opens DevTools for one exact preview guest. */
  async openDevTools(event: IpcMainInvokeEvent, input?: unknown): Promise<boolean> {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    const session = getSession(win);
    let threadId = session.lastPreviewThreadId;
    let tabId: string | null = null;
    const exactTargetRequested = input !== undefined;
    if (exactTargetRequested) {
      const target = asRecord(input);
      try {
        threadId = assertShortId(target.threadId, "threadId");
        tabId = assertShortId(target.tabId, "tabId");
      } catch {
        return false;
      }
    }
    if (!threadId) return false;
    const set = getThreadTabSet(session, threadId);
    const tab = set?.tabs.find((candidate) => candidate.id === (tabId ?? set.activeTabId));
    if (!tab) return false;
    const adopted = findAdoptedWebContentsForWindow(win.id, threadId, tab.id);
    const guest = adopted?.hostWebContents === event.sender ? adopted : null;
    if (!guest || guest.isDestroyed()) return false;
    const state = this.targets.get(targetKey(win.id, threadId, tab.id));
    if (state) {
      this.humanInterrupt(state);
      if (state.syntheticInputDepth > 0 && state.debuggerOwned) await this.releaseInput(guest, state.heldKeys);
      state.syntheticInputDepth = 0;
      if (state.debuggerOwned && guest.debugger.isAttached()) {
        guest.debugger.detach();
        state.debuggerOwned = false;
        state.diagnosticsReady = false;
        state.isolatedContextId = null;
      }
    }
    guest.openDevTools({ mode: "detach" });
    return true;
  }

  /** Subscribes a renderer window to controller changes without exposing debugger access. */
  subscribe(windowId: number, callback: (state: unknown) => void): () => void {
    const listeners = this.subscribers.get(windowId) ?? new Set();
    listeners.add(callback);
    this.subscribers.set(windowId, listeners);
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) this.subscribers.delete(windowId);
    };
  }

  /** Releases target listeners, debugger sessions, queues, and buffers for one window. */
  disposeWindow(windowId: number): void {
    for (const [key, state] of this.targets) {
      if (state.windowId !== windowId) continue;
      this.scheduler.cancelTarget(key);
      state.dispose();
      this.targets.delete(key);
    }
    for (const key of this.targetGenerations.keys()) {
      if (key.startsWith(`[${windowId},`)) this.targetGenerations.delete(key);
    }
    this.subscribers.delete(windowId);
  }

  /** Returns internal bounded counters for tests and performance diagnostics. */
  getCounters(): { targets: number; targetGenerations: number; cancellations: number; active: number; queued: number } {
    const queue = this.scheduler.getCounters();
    return { targets: this.targets.size, targetGenerations: this.targetGenerations.size, cancellations: this.cancellations.size, active: queue.active, queued: queue.queued };
  }

  private evictTargetGenerationTombstones(): void {
    let attempts = 0;
    while (this.targetGenerations.size > TARGET_GENERATION_TOMBSTONE_LIMIT && attempts <= this.targetGenerations.size) {
      attempts += 1;
      const oldest = this.targetGenerations.keys().next().value as string | undefined;
      if (!oldest) return;
      if (this.targets.has(oldest)) {
        const generation = this.targetGenerations.get(oldest)!;
        this.targetGenerations.delete(oldest);
        this.targetGenerations.set(oldest, generation);
        continue;
      }
      this.targetGenerations.delete(oldest);
      attempts = 0;
    }
  }

  private parseInput(input: unknown): BrowserAutomationIpcRequest {
    const parsed = BrowserAutomationHostDispatchSchema().safeParse(input);
    if (!parsed.success) throw new KernelError("INVALID_REQUEST", "Browser host dispatch failed exact scope validation", false);
    return parsed.data;
  }

  private resolveTarget(event: IpcMainInvokeEvent, threadId: string, target: BrowserAutomationIpcTarget): ResolvedTarget {
    const resolved = this.resolveCurrentTarget(event, threadId, target.tabId);
    if (target.windowId !== resolved.state.windowId) {
      throw new KernelError("TAB_UNAVAILABLE", "Browser dispatch window does not match the renderer", false);
    }
    if (target.targetGeneration !== resolved.state.targetGeneration) {
      throw new KernelError(
        "STALE_TARGET_GENERATION",
        `Browser target generation is stale; current generation is ${resolved.state.targetGeneration}`,
        true,
      );
    }
    return resolved;
  }

  private resolveCurrentTarget(
    event: IpcMainInvokeEvent,
    threadId: string,
    tabId: string,
  ): ResolvedTarget {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) throw new KernelError("TAB_UNAVAILABLE", "Browser window is unavailable", true);
    const session = getSession(win);
    const tab = getThreadTabSet(session, threadId)?.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.threadId !== threadId) {
      throw new KernelError("TAB_UNAVAILABLE", "Browser target slot is unavailable", true);
    }
    let webContents = findAdoptedWebContentsForWindow(win.id, threadId, tabId);
    if (webContents?.hostWebContents !== event.sender) webContents = null;
    if (!webContents || webContents.isDestroyed()) throw new KernelError("TAB_UNAVAILABLE", "Exact browser tab is unavailable", true);

    const key = targetKey(win.id, threadId, tabId);
    let state = this.targets.get(key);
    if (!state || state.webContents.id !== webContents.id) {
      const generation = (this.targetGenerations.get(key) ?? -1) + 1;
      state?.dispose();
      this.scheduler.cancelTarget(key);
      state = this.createTargetState(key, win.id, threadId, tabId, webContents, generation);
      this.targets.set(key, state);
      this.targetGenerations.delete(key);
      this.targetGenerations.set(key, generation);
      this.evictTargetGenerationTombstones();
    }
    return { state, webContents, window: win };
  }

  private restoreActivePreviewGuestFocus(resolved: ResolvedTarget): void {
    const { webContents, window } = resolved;
    if (window.isDestroyed() || !window.isFocused() || webContents.isDestroyed() || !webContents.isFocused()) return;
    const activeWebContents = resolveActivePreviewWebContentsForWindow(window.id, getSession(window));
    if (!activeWebContents || activeWebContents.id === webContents.id) return;
    activeWebContents.focus();
  }

  private createTargetState(
    key: string,
    windowId: number,
    threadId: string,
    tabId: string,
    webContents: WebContents,
    generation: number,
  ): TargetState {
    const state: TargetState = {
      key,
      windowId,
      threadId,
      tabId,
      webContents,
      targetGeneration: generation,
      semanticGeneration: 0,
      capabilityRevision: 1,
      controlEpoch: 0,
      controller: { tabId, controller: "none", controlEpoch: 0 },
      syntheticInputDepth: 0,
      syntheticInputUntil: 0,
      guestInputGeneration: 0,
      heldKeys: new Set(),
      automationNavigationDepth: 0,
      navigationSequence: 0,
      debuggerOwned: false,
      diagnosticsReady: false,
      diagnosticListenerReady: false,
      isolatedContextId: null,
      networkRequests: new Map(),
      console: new OldestFirstRingBuffer(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES),
      network: new OldestFirstRingBuffer(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES),
      actions: new OldestFirstRingBuffer(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES),
      dispose: () => undefined,
    };
    const onDestroyed = () => {
      this.scheduler.cancelTarget(key);
      state.semanticGeneration += 1;
      state.isolatedContextId = null;
      this.targets.delete(key);
      state.dispose();
    };
    const onNavigation = (_event: unknown, _url: string, _sameDocument: boolean, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      state.semanticGeneration += 1;
      state.isolatedContextId = null;
      if (
        state.automationNavigationDepth === 0 &&
        state.syntheticInputDepth === 0 &&
        Date.now() > state.syntheticInputUntil
      ) {
        this.scheduler.cancelTarget(
          state.key,
          new BrowserAutomationCancelledError("Browser target navigated"),
        );
      }
    };
    const onConsole = (_event: unknown, level: number, message: string, line: number, sourceId: string) => {
      const levels = ["debug", "info", "warning", "error"] as const;
      const sourceUrl = redactBrowserDiagnosticUrl(sourceId);
      state.console.push({
        timestamp: Date.now(),
        level: levels[Math.max(0, Math.min(level, 3))] ?? "info",
        text: redactBrowserText(message),
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(Number.isInteger(line) && line >= 0 ? { line } : {}),
      });
    };
    webContents.once("destroyed", onDestroyed);
    webContents.on("did-start-navigation", onNavigation);
    webContents.on("console-message", onConsole);
    state.dispose = () => {
      try {
        webContents.removeListener("destroyed", onDestroyed);
        webContents.removeListener("did-start-navigation", onNavigation);
        webContents.removeListener("console-message", onConsole);
        if (state.debuggerOwned && webContents.debugger.isAttached()) webContents.debugger.detach();
      } catch {
        // The guest may already be destroyed while Electron tears down its listeners.
      }
      state.console.clear();
      state.network.clear();
      state.networkRequests.clear();
      state.actions.clear();
    };
    return state;
  }

  private humanInterrupt(state: TargetState): void {
    if (state.controller.controller === "human") return;
    state.controlEpoch += 1;
    this.scheduler.cancelTarget(
      state.key,
      new KernelError("HUMAN_INTERRUPTED", "Human input took control of the browser", true),
    );
    state.actions.push({ timestamp: Date.now(), operation: "status", outcome: "interrupted", detail: "Human input took control" });
    this.emitController(state, "human");
  }

  private emitController(
    state: TargetState,
    controller: "none" | "human" | "agent",
    request?: BrowserAutomationRequest,
    pointer?: { x: number; y: number },
  ): void {
    const payload: BrowserAutomationControllerState = {
      tabId: state.tabId,
      controller,
      controlEpoch: state.controlEpoch,
      ...(request
        ? {
            providerSessionId: request.providerSessionId,
            ...(request.operation !== "inspect" && request.operation !== "act" && request.operation !== "tabs"
              ? { operation: request.operation }
              : {}),
          }
        : {}),
      ...(pointer ? { pointer } : {}),
    };
    state.controller = payload;
    for (const listener of this.subscribers.get(state.windowId) ?? []) listener(payload);
  }

  private async runOperation(resolved: ResolvedTarget, request: BrowserAutomationRequest, signal: AbortSignal): Promise<unknown> {
    const { state, webContents } = resolved;
    if (webContents.isDestroyed()) throw new KernelError("TAB_UNAVAILABLE", "Browser tab was closed", true);
    if (request.operation !== "status" && request.expectedControlEpoch !== state.controlEpoch) {
      throw new KernelError("STALE_CONTROL_EPOCH", `Control epoch is stale; current epoch is ${state.controlEpoch}`, true);
    }
    if (request.deadline <= Date.now()) throw new KernelError("DEADLINE_EXCEEDED", "Browser operation deadline elapsed", true);
    state.actions.push({ timestamp: Date.now(), operation: request.operation, outcome: "started" });
    if (request.operation !== "status") this.emitController(state, "agent", request);
    updateBrowserAutomationAgentOperationDepth(webContents, 1);
    let effect: KernelErrorEffect = "none";
    const markEffect = () => {
      if (effect === "none") effect = "preserved";
    };
    try {
      const operation = this.dispatch(resolved, request, signal, markEffect);
      const result = request.operation === "open" || request.operation === "navigate"
        ? await operation
        : await boundedRace(operation, signal, request.deadline);
      state.actions.push({ timestamp: Date.now(), operation: request.operation, outcome: "succeeded" });
      return result;
    } catch (cause) {
      const finalCause = effect === "none" ? cause : this.withEffect(cause, effect);
      state.actions.push({
        timestamp: Date.now(),
        operation: request.operation,
        outcome:
          finalCause instanceof BrowserAutomationCancelledError ||
          (finalCause instanceof KernelError && (finalCause.code === "HUMAN_INTERRUPTED" || finalCause.code === "OPERATION_CANCELLED"))
            ? "interrupted"
            : "failed",
        detail: redactBrowserText(finalCause instanceof Error ? finalCause.message : "Browser operation failed"),
      });
      throw finalCause;
    } finally {
      updateBrowserAutomationAgentOperationDepth(webContents, -1);
      if (state.syntheticInputDepth > 0 && state.debuggerOwned) {
        await Promise.race([
          this.releaseInput(state.webContents, state.heldKeys),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 500);
            timer.unref?.();
          }),
        ]);
      }
      state.syntheticInputDepth = 0;
    }
  }

  private async dispatch(
    resolved: ResolvedTarget,
    request: BrowserAutomationRequest,
    signal: AbortSignal,
    markEffect: () => void,
  ): Promise<unknown> {
    const { state, webContents } = resolved;
    const base = () => ({ url: redactBrowserLocation(webContents.getURL()), title: redactBrowserText(webContents.getTitle(), 4_096), controlEpoch: state.controlEpoch });
    switch (request.operation) {
      case "inspect": {
        const snapshot = await this.captureSnapshot(resolved, false);
        const screenshot = request.args.includeScreenshot
          ? await this.captureScreenshot(state, 1_280)
          : undefined;
        const diagnostics = request.args.includeDiagnostics
          ? state.console.read(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES).map((entry) => entry.text)
          : undefined;
        const mechanical: MechanicalInspectResult = {
          operation: "inspect",
          target: { threadId: state.threadId, tabId: state.tabId, targetGeneration: state.targetGeneration, sticky: true },
          tabs: [{
            desktopInstanceId: "electron",
            windowId: state.windowId,
            connectionGeneration: 1,
            threadId: state.threadId,
            tabId: state.tabId,
            targetGeneration: state.targetGeneration,
            active: getThreadTabSet(getSession(resolved.window), state.threadId)?.activeTabId === state.tabId,
            focused: webContents.isFocused(),
            lastUsedAt: Date.now(),
          }],
          snapshot: snapshot as MechanicalInspectResult["snapshot"],
          ...(screenshot ? { screenshot: screenshot as NonNullable<MechanicalInspectResult["screenshot"]> } : {}),
          ...(diagnostics ? { diagnostics } : {}),
        };
        return mechanical;
      }
      case "status":
        {
          const viewportValue = asRecord(await boundedRace(
            webContents.executeJavaScript("({ width: window.innerWidth, height: window.innerHeight })", true),
            signal,
            request.deadline,
          ));
          const width = Number(viewportValue.width);
          const height = Number(viewportValue.height);
          if (!Number.isFinite(width) || !Number.isFinite(height)) {
            throw new KernelError("TAB_UNAVAILABLE", "Browser viewport is unavailable", true);
          }
        const mechanical: MechanicalStatusResult = {
          operation: "status",
          available: true,
          active: getThreadTabSet(getSession(resolved.window), state.threadId)?.activeTabId === state.tabId,
          tabId: state.tabId,
          url: redactBrowserLocation(webContents.getURL()),
          loading: webContents.isLoading(),
          focused: webContents.isFocused(),
          viewport: {
            width: Math.max(1, Math.min(10_000, Math.round(width))),
            height: Math.max(1, Math.min(10_000, Math.round(height))),
          },
          controller: state.controller,
        };
        return mechanical;
        }
      case "open":
      case "navigate": {
        const url = request.operation === "navigate" ? request.args.url : request.args.url;
        if (url) {
          const navigationSequence = ++state.navigationSequence;
          const stopNavigation = () => {
            if (state.navigationSequence !== navigationSequence) return;
            state.navigationSequence += 1;
            if (!webContents.isDestroyed()) webContents.stop();
          };
          signal.addEventListener("abort", stopNavigation, { once: true });
          state.automationNavigationDepth += 1;
          try {
            const navigation = loadPreviewGuestUrl(webContents, url);
            markEffect();
            const result = await boundedRace(navigation, signal, request.deadline);
            if (signal.aborted || state.navigationSequence !== navigationSequence) {
              throw new BrowserAutomationCancelledError("Browser navigation was cancelled");
            }
            if (result.status === "failed") {
              throw new KernelError("NAVIGATION_FAILED", "Browser navigation failed", true);
            }
          } catch (cause) {
            if (
              cause instanceof BrowserAutomationCancelledError ||
              (cause instanceof KernelError &&
                (cause.code === "TIMEOUT" || cause.code === "DEADLINE_EXCEEDED"))
            ) {
              stopNavigation();
              throw cause;
            }
            if (cause instanceof KernelError) throw cause;
            throw new KernelError("NAVIGATION_FAILED", "Browser navigation failed", true);
          } finally {
            signal.removeEventListener("abort", stopNavigation);
            state.automationNavigationDepth -= 1;
          }
        }
        return {
          operation: request.operation,
          ...base(),
          ...(request.operation === "open" ? { observationRef: randomUUID() } : {}),
        };
      }
      case "back":
      case "forward":
      case "reload": {
        const canNavigate = request.operation === "back"
          ? webContents.canGoBack()
          : request.operation === "forward"
            ? webContents.canGoForward()
            : true;
        if (!canNavigate) throw new KernelError("TARGET_NOT_FOUND", "Browser history has no requested entry", true);
        const navigationSequence = ++state.navigationSequence;
        const stopNavigation = () => {
          if (state.navigationSequence !== navigationSequence) return;
          state.navigationSequence += 1;
          if (!webContents.isDestroyed()) webContents.stop();
        };
        state.automationNavigationDepth += 1;
        let removeStoppedListener: () => void = () => undefined;
        try {
          const stopped = new Promise<void>((resolve) => {
            const onStopped = () => {
              webContents.removeListener("did-stop-loading", onStopped);
              resolve();
            };
            removeStoppedListener = () => { webContents.removeListener("did-stop-loading", onStopped); };
            webContents.once("did-stop-loading", onStopped);
          });
          signal.addEventListener("abort", stopNavigation, { once: true });
          if (request.operation === "back") webContents.goBack();
          else if (request.operation === "forward") webContents.goForward();
          else webContents.reload();
          markEffect();
          await boundedRace(stopped, signal, request.deadline);
          if (signal.aborted || state.navigationSequence !== navigationSequence) {
            throw new BrowserAutomationCancelledError("Browser navigation was cancelled");
          }
        } finally {
          removeStoppedListener();
          signal.removeEventListener("abort", stopNavigation);
          state.automationNavigationDepth -= 1;
        }
        return { operation: request.operation, ...base() };
      }
      case "resize":
        throw new KernelError("UNSUPPORTED_OPERATION", "Renderer-hosted browser resize is unavailable", false);
      case "snapshot": {
        const snapshot = await this.captureSnapshot(resolved, request.args.includeScreenshot);
        return { operation: "snapshot", snapshot, controlEpoch: state.controlEpoch };
      }
      case "screenshot": {
        if (request.args.fullPage) throw new KernelError("UNSUPPORTED_OPERATION", "Full-page screenshot is unavailable", false);
        return { operation: "screenshot", screenshot: await this.captureScreenshot(state, request.args.maxWidth), controlEpoch: state.controlEpoch };
      }
      case "click": {
        const point = await this.resolvePoint(resolved, request.args.target);
        this.emitController(state, "agent", request, point);
        await this.withSyntheticInput(state, async () => {
          await this.ensureDebugger(state);
          await this.dispatchGuestInput(
            state,
            "pointer",
            () => webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: point.x,
              y: point.y,
              button: request.args.button,
              clickCount: request.args.clickCount,
            }),
            markEffect,
          );
          this.throwIfAborted(signal);
          try {
            await webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: request.args.button, clickCount: request.args.clickCount });
          } catch (cause) {
            await this.releaseInput(webContents, state.heldKeys);
            throw cause;
          }
        });
        return { operation: "click", ...base() };
      }
      case "type": {
        if (request.args.target) {
          const point = await this.resolvePoint(resolved, request.args.target);
          this.emitController(state, "agent", request, point);
          await this.withSyntheticInput(state, () => this.clickPoint(state, point, markEffect));
          this.throwIfAborted(signal);
        }
        await this.withSyntheticInput(state, async () => {
          await this.ensureDebugger(state);
          if (request.args.clear) {
            await this.pressKey(state, "a", selectAllModifierMask() === 4 ? ["Meta"] : ["Control"], markEffect);
            await this.pressKey(state, "Backspace", [], markEffect);
          }
          this.throwIfAborted(signal);
          const insertion = webContents.debugger.sendCommand("Input.insertText", { text: request.args.text });
          markEffect();
          await insertion;
          this.throwIfAborted(signal);
          if (request.args.submit) await this.pressKey(state, "Enter", [], markEffect);
        });
        return { operation: "type", ...base() };
      }
      case "press":
        await this.withSyntheticInput(state, () => this.pressKey(state, request.args.key, request.args.modifiers, markEffect));
        this.throwIfAborted(signal);
        return { operation: "press", ...base() };
      case "scroll": {
        const point = request.args.target ? await this.resolvePoint(resolved, request.args.target) : { x: 1, y: 1 };
        await this.withSyntheticInput(state, async () => {
          await this.ensureDebugger(state);
          await this.dispatchGuestInput(
            state,
            "wheel",
            () => webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x: point.x,
              y: point.y,
              deltaX: request.args.deltaX,
              deltaY: request.args.deltaY,
            }),
            markEffect,
          );
          this.throwIfAborted(signal);
        });
        return { operation: "scroll", ...base() };
      }
      case "waitFor":
        await this.waitFor(
          resolved,
          request.args,
          signal,
          Math.min(request.deadline, Date.now() + request.args.timeoutMs),
        );
        return { operation: "waitFor", ...base() };
      case "wait": {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await boundedRace(
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, request.args.durationMs);
              timer.unref?.();
            }),
            signal,
            Math.min(request.deadline, Date.now() + request.args.durationMs),
          );
        } finally {
          if (timer) clearTimeout(timer);
        }
        return { operation: "wait", ...base() };
      }
      case "console": {
        const filtered = state.console.read(BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES).filter((entry) =>
          (!request.args.levels || request.args.levels.includes(entry.level)) &&
          (!request.args.source || entry.sourceUrl === request.args.source),
        );
        const originalCount = filtered.length;
        const entries = filtered.slice(-request.args.limit);
        return { operation: "console", entries, truncation: { truncated: originalCount > entries.length, originalCount } };
      }
      case "network": {
        await this.ensureDebugger(state);
        const originalCount = state.network.size;
        const all = state.network.read(request.args.limit);
        const entries = request.args.failedOnly ? all.filter((entry) => entry.failed) : all;
        return { operation: "network", entries, truncation: { truncated: originalCount > entries.length, originalCount } };
      }
      case "accessibility":
        return { operation: "accessibility", ...(await this.captureAccessibility(state, request.args.limit, request.args.root)) };
      case "performance":
        return { operation: "performance", metrics: await this.capturePerformance(state, request.args.includeMemory), controlEpoch: state.controlEpoch };
      case "evaluate": {
        if (byteLength(request.args.expression) > EVALUATION_LIMIT) throw new KernelError("INVALID_REQUEST", "Evaluation expression exceeds 64 KiB", false);
        const timeoutMs = Math.min(request.args.timeoutMs, Math.max(1, request.deadline - Date.now()));
        try {
          const evaluation = this.callIsolatedFunction(
            state,
            evaluateIsolatedExpression,
            {
              expression: request.args.expression,
              awaitPromise: request.args.awaitPromise,
              maxBytes: EVALUATION_LIMIT,
            },
            { awaitPromise: true, timeoutMs, onDispatch: markEffect },
          );
          const evaluated = asRecord(await boundedRace(evaluation, signal, Date.now() + timeoutMs));
          if (evaluated.ok !== true || typeof evaluated.valueJson !== "string") {
            throw new KernelError("RESULT_TOO_LARGE", "Evaluation result exceeds 64 KiB", false);
          }
          return { operation: "evaluate", valueJson: evaluated.valueJson, controlEpoch: state.controlEpoch };
        } catch (cause) {
          if (state.webContents.debugger.isAttached()) {
            await Promise.race([
              state.webContents.debugger.sendCommand("Runtime.terminateExecution"),
              new Promise((resolve) => setTimeout(resolve, 250)),
            ]).catch(() => undefined);
          }
          state.isolatedContextId = null;
          if (
            !(cause instanceof KernelError) &&
            !(cause instanceof BrowserAutomationCancelledError) &&
            /tim(?:e|ed)\s*out|terminated/i.test(cause instanceof Error ? cause.message : String(cause))
          ) {
            throw new KernelError("TIMEOUT", "Browser evaluation timed out", true);
          }
          throw cause;
        }
      }
      case "recordingStart":
      case "recordingStop":
        throw new KernelError("UNSUPPORTED_OPERATION", "Browser recording is not available in this host", false);
    }
  }

  private async withSyntheticInput<T>(state: TargetState, action: () => Promise<T>): Promise<T> {
    state.syntheticInputDepth += 1;
    let succeeded = false;
    try {
      const result = await action();
      succeeded = true;
      return result;
    } finally {
      if (state.debuggerOwned) state.syntheticInputUntil = succeeded ? Date.now() + 250 : 0;
      try {
        if (state.syntheticInputDepth > 0 && state.debuggerOwned) {
          await this.releaseInput(state.webContents, state.heldKeys);
        }
      } finally {
        state.syntheticInputDepth = Math.max(0, state.syntheticInputDepth - 1);
      }
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new BrowserAutomationCancelledError();
  }

  private suppressGuestInput(
    state: TargetState,
    kind: "keyboard" | "pointer" | "wheel",
    count = 1,
  ): GuestInputAllowanceHandle | null {
    if (state.webContents.isDestroyed()) return null;
    const generation = ++state.guestInputGeneration;
    const token = randomUUID();
    state.webContents.send(PREVIEW_GUEST_AGENT_INPUT_CHANNEL, {
      action: "allow",
      token,
      generation,
      kind,
      count: Math.max(1, Math.min(16, Math.trunc(count))),
      expiresAt: Date.now() + 5_000,
    });
    return { token, generation };
  }

  private revokeGuestInput(state: TargetState, allowance: GuestInputAllowanceHandle | null): void {
    if (!allowance || state.webContents.isDestroyed()) return;
    state.webContents.send(PREVIEW_GUEST_AGENT_INPUT_CHANNEL, {
      action: "revoke",
      token: allowance.token,
      generation: allowance.generation,
    });
  }

  private async dispatchGuestInput<T>(
    state: TargetState,
    kind: "keyboard" | "pointer" | "wheel",
    dispatch: () => Promise<T>,
    markEffect?: () => void,
  ): Promise<T> {
    const allowance = this.suppressGuestInput(state, kind);
    let succeeded = false;
    try {
      const pending = dispatch();
      markEffect?.();
      const result = await pending;
      succeeded = true;
      return result;
    } finally {
      if (!succeeded) this.revokeGuestInput(state, allowance);
    }
  }

  private async clickPoint(state: TargetState, point: { x: number; y: number }, markEffect?: () => void): Promise<void> {
    await this.ensureDebuggerForWebContents(state.webContents);
    await this.dispatchGuestInput(
      state,
      "pointer",
      () => state.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      }),
      markEffect,
    );
    await state.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  }

  private async pressKey(
    state: TargetState,
    key: string,
    modifiers: readonly string[],
    markEffect?: () => void,
  ): Promise<void> {
    const webContents = state.webContents;
    await this.ensureDebuggerForWebContents(webContents);
    if (state.heldKeys.size >= 32 && !state.heldKeys.has(key)) {
      throw new KernelError("INVALID_REQUEST", "Too many browser keys are held", false);
    }
    const mask = modifiers.reduce((value, modifier) => value | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[modifier] ?? 0), 0);
    state.heldKeys.add(key);
    await this.dispatchGuestInput(
      state,
      "keyboard",
      () => webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key, modifiers: mask }),
      markEffect,
    );
    try {
      await webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers: mask });
      state.heldKeys.delete(key);
    } catch (cause) {
      await this.releaseInput(webContents, state.heldKeys);
      throw cause;
    }
  }

  private async releaseInput(webContents: WebContents, heldKeys: Set<string> = new Set()): Promise<void> {
    if (webContents.isDestroyed() || !webContents.debugger.isAttached()) {
      heldKeys.clear();
      return;
    }
    await Promise.allSettled([
      ...[...heldKeys].map((key) => webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers: 0 })),
      webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Alt", modifiers: 0 }),
      webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", modifiers: 0 }),
      webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Meta", modifiers: 0 }),
      webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", modifiers: 0 }),
      webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: 0, y: 0, button: "left", clickCount: 1 }),
      webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: 0, y: 0, button: "middle", clickCount: 1 }),
      webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: 0, y: 0, button: "right", clickCount: 1 }),
    ]);
    heldKeys.clear();
  }

  private async resolvePoint(resolved: ResolvedTarget, target: BrowserAutomationTarget): Promise<{ x: number; y: number }> {
    const value = await this.callIsolatedFunction(resolved.state, inspectPageTarget, { target, scrollIntoView: true });
    const record = asRecord(value);
    if (!record.attached || !record.visible || !Number.isFinite(record.x) || !Number.isFinite(record.y)) {
      throw new KernelError("TARGET_NOT_FOUND", "Browser target did not resolve to one visible element", true);
    }
    return { x: Number(record.x), y: Number(record.y) };
  }

  private async waitFor(resolved: ResolvedTarget, args: Record<string, unknown>, signal: AbortSignal, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      if (signal.aborted) throw new BrowserAutomationCancelledError();
      if ("url" in args && resolved.webContents.getURL() === args.url) return;
      if ("text" in args) {
        const found = await this.callIsolatedFunction(
          resolved.state,
          (text: string) => (document.body?.innerText ?? "").includes(text),
          String(args.text),
        );
        if (found) return;
      }
      if ("target" in args) {
        const inspected = asRecord(await this.callIsolatedFunction(
          resolved.state,
          inspectPageTarget,
          { target: args.target as BrowserAutomationTarget },
        ));
        const desired = args.state ?? "visible";
        const attached = inspected.attached === true;
        const visible = inspected.visible === true;
        if (desired === "attached" && attached) return;
        if (desired === "visible" && attached && visible) return;
        if (desired === "hidden" && attached && !visible) return;
        if (desired === "detached" && !attached) return;
      }
      await boundedRace(new Promise((resolve) => setTimeout(resolve, 50)), signal, deadline);
    }
    throw new KernelError("TIMEOUT", "waitFor timed out", true);
  }

  private async captureSnapshot(resolved: ResolvedTarget, includeScreenshot: boolean): Promise<Record<string, unknown>> {
    const raw = asRecord(await this.callIsolatedFunction(
      resolved.state,
      snapshotPage,
      { semanticGeneration: resolved.state.semanticGeneration, maxElements: BROWSER_AUTOMATION_MAX_ELEMENTS, maxText: BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS },
    ));
    const accessibility = await this.captureAccessibility(resolved.state, BROWSER_AUTOMATION_MAX_AX_NODES);
    const visibleText = redactBrowserText(raw.visibleText, BROWSER_AUTOMATION_MAX_VISIBLE_TEXT_CHARS);
    const rawVisibleTextCount = Number.isFinite(raw.visibleTextOriginalLength)
      ? Math.max(0, Math.floor(Number(raw.visibleTextOriginalLength)))
      : visibleText.length;
    const visibleTextOriginalCount = Math.max(rawVisibleTextCount, visibleText.length);
    const visibleTextTruncated = visibleTextOriginalCount > visibleText.length;
    const rawElements = Array.isArray(raw.elements) ? raw.elements : [];
    const rawElementCount = Math.max(rawElements.length, Number.isFinite(raw.elementCount)
      ? Math.max(0, Math.floor(Number(raw.elementCount)))
      : 0);
    const elements = redactBrowserValue(rawElements) as unknown[];
    const structuredBudget = includeScreenshot
      ? SNAPSHOT_STRUCTURED_BUDGET_WITH_IMAGE
      : SNAPSHOT_RESPONSE_BUDGET;
    const snapshot: Record<string, unknown> = {
      url: redactBrowserLocation(raw.url),
      title: redactBrowserText(raw.title),
      loading: Boolean(raw.loading),
      visibleText,
      visibleTextTruncation: visibleTextTruncated
        ? { truncated: true, originalCount: visibleTextOriginalCount, reason: "character-limit" }
        : { truncated: false, originalCount: visibleTextOriginalCount },
      elements: [],
      elementsTruncation: rawElementCount > BROWSER_AUTOMATION_MAX_ELEMENTS
        ? { truncated: true, originalCount: rawElementCount, reason: "entry-limit" }
        : { truncated: false, originalCount: rawElementCount },
      accessibility: [],
      accessibilityTruncation: accessibility.truncation,
      console: [],
      consoleTruncation: this.bufferTruncation(resolved.state.console),
      network: [],
      networkTruncation: this.bufferTruncation(resolved.state.network),
      actions: [],
      actionsTruncation: this.bufferTruncation(resolved.state.actions),
    };
    this.fitSnapshotText(snapshot, structuredBudget, visibleTextOriginalCount);
    this.fitSnapshotCollection(snapshot, "elements", "elementsTruncation", elements, structuredBudget);
    this.fitSnapshotCollection(snapshot, "accessibility", "accessibilityTruncation", accessibility.nodes, structuredBudget);
    this.fitSnapshotCollection(snapshot, "console", "consoleTruncation", resolved.state.console.read(), structuredBudget);
    this.fitSnapshotCollection(snapshot, "network", "networkTruncation", resolved.state.network.read(), structuredBudget);
    this.fitSnapshotCollection(snapshot, "actions", "actionsTruncation", resolved.state.actions.read(), structuredBudget);
    if (includeScreenshot) {
      const remainingJsonBytes = SNAPSHOT_RESPONSE_BUDGET - byteLength(JSON.stringify(snapshot));
      const maxScreenshotBytes = Math.max(0, Math.floor((remainingJsonBytes - 1_024) * 0.75));
      if (maxScreenshotBytes >= 1_024) {
        try {
          snapshot.screenshot = await this.captureScreenshot(
            resolved.state,
            1_280,
            Math.min(SCREENSHOT_BINARY_LIMIT, maxScreenshotBytes),
          );
        } catch (cause) {
          if (!(cause instanceof KernelError) || cause.code !== "RESULT_TOO_LARGE") throw cause;
        }
      }
    }
    if (byteLength(JSON.stringify(snapshot)) > SNAPSHOT_RESPONSE_BUDGET) {
      throw new KernelError("RESULT_TOO_LARGE", "Snapshot cannot fit the 512 KiB response envelope", false);
    }
    return snapshot;
  }

  private fitSnapshotText(
    snapshot: Record<string, unknown>,
    budget: number,
    originalCount: number,
  ): void {
    const text = String(snapshot.visibleText ?? "");
    if (byteLength(JSON.stringify(snapshot)) <= budget) return;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      snapshot.visibleText = text.slice(0, middle);
      if (byteLength(JSON.stringify(snapshot)) <= budget) low = middle;
      else high = middle - 1;
    }
    snapshot.visibleText = text.slice(0, low);
    if (low < text.length) {
      snapshot.visibleTextTruncation = {
        truncated: true,
        originalCount: Math.max(originalCount, text.length),
        reason: "byte-limit",
      };
    }
  }

  private fitSnapshotCollection(
    snapshot: Record<string, unknown>,
    collectionKey: string,
    truncationKey: string,
    values: readonly unknown[],
    budget: number,
  ): void {
    const existing = asRecord(snapshot[truncationKey]);
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      snapshot[collectionKey] = values.slice(0, middle);
      if (byteLength(JSON.stringify(snapshot)) <= budget) low = middle;
      else high = middle - 1;
    }
    snapshot[collectionKey] = values.slice(0, low);
    if (low < values.length) {
      const recordedOriginal = Number.isFinite(existing.originalCount)
        ? Math.floor(Number(existing.originalCount))
        : values.length;
      snapshot[truncationKey] = {
        truncated: true,
        originalCount: Math.max(values.length, recordedOriginal, low + 1),
        reason: "byte-limit",
      };
    }
  }

  private bufferTruncation<T>(buffer: OldestFirstRingBuffer<T>): Record<string, unknown> {
    return buffer.evicted > 0
      ? { truncated: true, originalCount: buffer.size + buffer.evicted, reason: "entry-limit" }
      : { truncated: false, originalCount: buffer.size };
  }

  private async captureScreenshot(
    state: TargetState,
    maxWidth: number,
    maxBinaryBytes = SCREENSHOT_BINARY_LIMIT,
  ): Promise<Record<string, unknown>> {
    await this.ensureDebugger(state);
    const response = asRecord(await state.webContents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    }));
    const data = typeof response.data === "string" ? response.data : "";
    if (data.length === 0) {
      throw new KernelError("INTERNAL_ERROR", "Browser screenshot capture returned no image data", true);
    }
    let image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
    const original = image.getSize();
    if (original.width <= 0 || original.height <= 0) {
      throw new KernelError("INTERNAL_ERROR", "Browser screenshot capture returned an empty image", true);
    }
    if (original.width > maxWidth) image = image.resize({ width: maxWidth, quality: "better" });
    let buffer = image.toPNG();
    while (buffer.byteLength > maxBinaryBytes && image.getSize().width > 320) {
      const nextWidth = Math.max(320, Math.floor(image.getSize().width * 0.75));
      image = image.resize({ width: nextWidth, quality: "better" });
      buffer = image.toPNG();
    }
    if (buffer.byteLength > maxBinaryBytes) {
      throw new KernelError("RESULT_TOO_LARGE", "Screenshot cannot fit the 512 KiB response envelope", false);
    }
    const size = image.getSize();
    return { mediaType: "image/png", dataBase64: buffer.toString("base64"), width: size.width, height: size.height, truncation: { truncated: original.width !== size.width, originalCount: original.width } };
  }

  private async ensureIsolatedContext(state: TargetState): Promise<number> {
    await this.ensureDebugger(state);
    if (state.isolatedContextId !== null) return state.isolatedContextId;
    const frameTree = asRecord(await state.webContents.debugger.sendCommand("Page.getFrameTree"));
    const frameId = asRecord(asRecord(frameTree.frameTree).frame).id;
    if (typeof frameId !== "string" || frameId.length === 0) {
      throw new KernelError("DEBUGGER_CONFLICT", "Browser main frame is unavailable", true);
    }
    const isolated = asRecord(await state.webContents.debugger.sendCommand("Page.createIsolatedWorld", {
      frameId,
      worldName: "mcode-browser-automation",
      grantUniveralAccess: false,
    }));
    if (!Number.isInteger(isolated.executionContextId) || Number(isolated.executionContextId) <= 0) {
      throw new KernelError("DEBUGGER_CONFLICT", "Browser isolated world is unavailable", true);
    }
    state.isolatedContextId = Number(isolated.executionContextId);
    return state.isolatedContextId;
  }

  private async callIsolatedFunction<TArgument>(
    state: TargetState,
    fn: (argument: TArgument) => unknown,
    argument: TArgument,
    options?: { awaitPromise?: boolean; returnByValue?: boolean; timeoutMs?: number; onDispatch?: () => void },
  ): Promise<unknown> {
    const executionContextId = await this.ensureIsolatedContext(state);
    const responsePromise = state.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
      functionDeclaration: fn.toString(),
      executionContextId,
      arguments: [{ value: argument }],
      awaitPromise: options?.awaitPromise ?? true,
      returnByValue: options?.returnByValue ?? true,
      userGesture: false,
      ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    options?.onDispatch?.();
    const response = asRecord(await responsePromise);
    if (response.exceptionDetails) {
      const details = asRecord(response.exceptionDetails);
      throw new KernelError(
        "INTERNAL_ERROR",
        redactBrowserText(details.text || "Browser isolated execution failed"),
        true,
      );
    }
    const result = asRecord(response.result);
    return options?.returnByValue === false ? result : result.value;
  }

  private async ensureDebugger(state: TargetState): Promise<void> {
    if (state.webContents.isDestroyed()) throw new KernelError("TAB_UNAVAILABLE", "Browser tab was destroyed", true);
    if (state.webContents.debugger.isAttached() && !state.debuggerOwned) {
      throw new KernelError("DEBUGGER_CONFLICT", "Browser debugger is already in use; close DevTools and retry", true);
    }
    if (!state.webContents.debugger.isAttached()) {
      try {
        state.webContents.debugger.attach("1.3");
        state.debuggerOwned = true;
        state.diagnosticsReady = false;
      } catch {
        throw new KernelError("DEBUGGER_CONFLICT", "Browser debugger is already in use; close DevTools and retry", true);
      }
    }
    if (state.diagnosticsReady) return;
    try {
      await state.webContents.debugger.sendCommand("Page.enable");
      await state.webContents.debugger.sendCommand("Runtime.enable");
      await state.webContents.debugger.sendCommand("DOM.enable");
      await state.webContents.debugger.sendCommand("Accessibility.enable");
      await state.webContents.debugger.sendCommand("Network.enable", { maxTotalBufferSize: 1, maxResourceBufferSize: 1, maxPostDataSize: 0 });
      await state.webContents.debugger.sendCommand("Performance.enable");
    } catch {
      throw new KernelError("DEBUGGER_CONFLICT", "Browser debugger could not enable bounded diagnostics", true);
    }
    const onMessage = (_event: unknown, method: string, params: unknown) => {
      const data = asRecord(params);
      if (method === "Network.requestWillBeSent") {
        const requestId = String(data.requestId ?? "");
        const request = asRecord(data.request);
        const requestUrl = redactBrowserDiagnosticUrl(request.url);
        if (!requestId || !requestUrl) return;
        if (state.networkRequests.size >= BROWSER_AUTOMATION_MAX_DIAGNOSTIC_ENTRIES) {
          const oldest = state.networkRequests.keys().next().value as string | undefined;
          if (oldest) state.networkRequests.delete(oldest);
        }
        state.networkRequests.set(requestId, {
          url: requestUrl,
          method: redactBrowserText(request.method || "GET").slice(0, 32) || "GET",
        });
      } else if (method === "Network.responseReceived") {
        const response = asRecord(data.response);
        const requestId = String(data.requestId ?? "");
        const request = state.networkRequests.get(requestId);
        const requestUrl = request?.url ?? redactBrowserDiagnosticUrl(response.url);
        if (!requestUrl) return;
        state.network.push({ timestamp: Date.now(), url: requestUrl, method: request?.method ?? "GET", status: Number(response.status) || 0, failed: Number(response.status) >= 400 });
      } else if (method === "Network.loadingFailed") {
        const requestId = String(data.requestId ?? "");
        const request = state.networkRequests.get(requestId);
        const requestUrl = request?.url ?? redactBrowserDiagnosticUrl(data.url);
        if (!requestUrl) return;
        state.network.push({ timestamp: Date.now(), url: requestUrl, method: request?.method ?? "GET", failed: true, errorText: redactBrowserText(data.errorText) });
      }
    };
    if (!state.diagnosticListenerReady) {
      const onDetach = () => {
        state.debuggerOwned = false;
        state.diagnosticsReady = false;
        state.isolatedContextId = null;
      };
      state.webContents.debugger.on("message", onMessage);
      state.webContents.debugger.on("detach", onDetach);
      const previousDispose = state.dispose;
      state.dispose = () => {
        try {
          state.webContents.debugger.removeListener("message", onMessage);
          state.webContents.debugger.removeListener("detach", onDetach);
        } catch { /* target already gone */ }
        previousDispose();
      };
      state.diagnosticListenerReady = true;
    }
    state.diagnosticsReady = true;
  }

  private async ensureDebuggerForWebContents(webContents: WebContents): Promise<void> {
    const state = [...this.targets.values()].find((candidate) => candidate.webContents.id === webContents.id);
    if (!state) throw new KernelError("TAB_UNAVAILABLE", "Browser target registration was lost", true);
    await this.ensureDebugger(state);
  }

  private async captureAccessibility(
    state: TargetState,
    limit: number,
    root?: BrowserAutomationTarget,
  ): Promise<{ nodes: unknown[]; truncation: Record<string, unknown> }> {
    await this.ensureDebugger(state);
    let backendNodeId: number;
    if (root) {
      const remote = asRecord(await this.callIsolatedFunction(
        state,
        resolvePageTargetElement,
        root,
        { awaitPromise: false, returnByValue: false },
      ));
      if (typeof remote.objectId !== "string") {
        throw new KernelError("TARGET_NOT_FOUND", "Accessibility root did not resolve uniquely", true);
      }
      const described = asRecord(await state.webContents.debugger.sendCommand("DOM.describeNode", {
        objectId: remote.objectId,
        depth: 0,
        pierce: false,
      }));
      backendNodeId = Number(asRecord(described.node).backendNodeId);
      await state.webContents.debugger.sendCommand("Runtime.releaseObject", { objectId: remote.objectId }).catch(() => undefined);
    } else {
      const documentNode = asRecord(await state.webContents.debugger.sendCommand("DOM.getDocument", {
        depth: 0,
        pierce: false,
      }));
      backendNodeId = Number(asRecord(documentNode.root).backendNodeId);
    }
    if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) {
      throw new KernelError("TARGET_NOT_FOUND", "Accessibility root is unavailable", true);
    }
    const response = asRecord(await state.webContents.debugger.sendCommand("Accessibility.getPartialAXTree", {
      backendNodeId,
      fetchRelatives: true,
    }));
    const rawNodes = Array.isArray(response.nodes) ? response.nodes : [];
    const rawById = new Map<string, Record<string, unknown>>();
    for (const raw of rawNodes.slice(0, BROWSER_AUTOMATION_MAX_AX_NODES)) {
      const node = asRecord(raw);
      rawById.set(String(node.nodeId ?? ""), node);
    }
    const depthFor = (node: Record<string, unknown>): number => {
      let depth = 0;
      let parentId = typeof node.parentId === "string" ? node.parentId : null;
      const visited = new Set<string>();
      while (parentId && depth < 1_000 && !visited.has(parentId)) {
        visited.add(parentId);
        depth += 1;
        const parent = rawById.get(parentId);
        parentId = parent && typeof parent.parentId === "string" ? parent.parentId : null;
      }
      return depth;
    };
    const nodes = rawNodes.slice(0, limit).map((raw, index) => {
      const node = asRecord(raw);
      const role = redactBrowserText(asRecord(node.role).value).slice(0, 128);
      return {
        nodeId: String(node.nodeId ?? index).slice(0, 1024),
        ...(node.parentId ? { parentId: String(node.parentId).slice(0, 1024) } : {}),
        role,
        name: redactBrowserText(asRecord(node.name).value).slice(0, 1024),
        ...(role !== "textbox" && asRecord(node.value).value !== undefined
          ? { value: redactBrowserText(asRecord(node.value).value).slice(0, 1024) }
          : {}),
        depth: depthFor(node),
        ignored: Boolean(node.ignored),
      };
    });
    return { nodes, truncation: { truncated: rawNodes.length > nodes.length, originalCount: rawNodes.length } };
  }

  private async capturePerformance(state: TargetState, includeMemory: boolean): Promise<Record<string, unknown>> {
    await this.ensureDebugger(state);
    const metricsResponse = asRecord(await state.webContents.debugger.sendCommand("Performance.getMetrics"));
    const metrics = new Map<string, number>();
    for (const raw of Array.isArray(metricsResponse.metrics) ? metricsResponse.metrics : []) {
      const metric = asRecord(raw);
      if (typeof metric.name === "string" && typeof metric.value === "number") metrics.set(metric.name, metric.value);
    }
    const timing = asRecord(await this.callIsolatedFunction(
      state,
      capturePagePerformance,
      null,
    ));
    const navigation = asRecord(timing.navigation);
    const resources = asRecord(timing.resources);
    const longTasks = asRecord(timing.longTasks);
    const result: Record<string, unknown> = {
      capturedAt: Date.now(),
      navigation: {
        ...(Number(navigation.ttfb) >= 0 ? { timeToFirstByteMs: Number(navigation.ttfb) } : {}),
        ...(Number(navigation.dcl) >= 0 ? { domContentLoadedMs: Number(navigation.dcl) } : {}),
        ...(Number(navigation.load) >= 0 ? { loadMs: Number(navigation.load) } : {}),
      },
      resources: { count: Math.max(0, Number(resources.count) || 0), transferBytes: Math.max(0, Math.floor(Number(resources.transferBytes) || 0)), decodedBodyBytes: Math.max(0, Math.floor(Number(resources.decodedBodyBytes) || 0)) },
      responsiveness: { longTaskCount: Math.max(0, Number(longTasks.count) || 0), totalBlockingTimeMs: Math.max(0, Number(longTasks.totalBlockingTimeMs) || 0) },
    };
    const jsHeapLimitBytes = Math.max(0, Math.floor(Number(timing.jsHeapLimitBytes) || 0));
    if (includeMemory && jsHeapLimitBytes > 0) {
      result.memory = {
        usedJsHeapBytes: Math.max(0, Math.floor((metrics.get("JSHeapUsedSize") ?? 0))),
        totalJsHeapBytes: Math.max(0, Math.floor((metrics.get("JSHeapTotalSize") ?? 0))),
        jsHeapLimitBytes,
      };
    }
    return result;
  }

  private withEffect(cause: unknown, effect: KernelErrorEffect): unknown {
    if (cause instanceof KernelError) {
      return new KernelError(cause.code, cause.message, cause.retryable, effect);
    }
    if (cause instanceof BrowserAutomationCancelledError) {
      return new KernelError("OPERATION_CANCELLED", cause.message, true, effect);
    }
    return new KernelError("INTERNAL_ERROR", "Browser automation failed", true, effect);
  }

  private failureResponse(request: BrowserAutomationRequest | null, cause: unknown): BrowserAutomationResponse {
    const mapped = cause instanceof KernelError
      ? cause
      : cause instanceof BrowserAutomationCancelledError
        ? new KernelError("OPERATION_CANCELLED", cause.message, true)
        : cause instanceof BrowserAutomationQueueFullError
          ? new KernelError("HOST_UNAVAILABLE", cause.message, true)
          : new KernelError("INTERNAL_ERROR", "Browser automation failed", true);
    return {
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: request?.requestId ?? "invalid-request",
      sequence: request?.sequence ?? 0,
      ok: false,
      error: {
        code: mapped.code,
        message: redactBrowserText(mapped.message),
        retryable: mapped.retryable,
        stage: mapped.code === "TAB_UNAVAILABLE" ? "allocation" : "effect",
        effect: mapped.code === "TAB_UNAVAILABLE" && mapped.effect === "none" ? "unknown" : mapped.effect,
        recovery: mapped.retryable ? "retry" : "manual",
        correlationId: randomUUID(),
      },
    };
  }
}
