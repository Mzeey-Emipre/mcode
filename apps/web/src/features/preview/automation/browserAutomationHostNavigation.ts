import type { BrowserAutomationHostDispatch } from "@mcode/contracts";
import { browserAutomationTargetKey } from "./browserAutomationStore";
import { normalizeWebPreviewUrl } from "./browserAutomationRuntime";
import { resolveSameOriginFrame } from "./webBrowserInteractionExecutor";

/** Escape a browser target value for an iframe attribute selector. */
export function escapeWebSelector(value: string): string {
  const escape = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS?.escape;
  return escape ? escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

/** Return the selector for a web preview iframe target. */
export function webIframeSelector(workspaceId: string, threadId: string, tabId: string): string {
  return `iframe[data-workspace-id="${escapeWebSelector(workspaceId)}"][data-scope-kind="thread"][data-scope-id="${escapeWebSelector(threadId)}"][data-tab-id="${escapeWebSelector(tabId)}"]`;
}

/** Find a same-origin preview iframe with the requested URL. */
export function webPreviewIframe(
  workspaceId: string,
  threadId: string,
  tabId: string,
  expectedUrl: string,
): HTMLIFrameElement | null {
  const iframe = document.querySelector<HTMLIFrameElement>(webIframeSelector(workspaceId, threadId, tabId));
  if (!iframe || normalizeWebPreviewUrl(iframe.src) !== expectedUrl) return null;
  return resolveSameOriginFrame(iframe) ? iframe : null;
}

/** Return whether a preview URL resolves to the renderer origin. */
export function isSameOriginWebPreviewUrl(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** Wait until a matching preview iframe attaches and loads. */
export function waitForWebPreviewIframe(
  workspaceId: string,
  threadId: string,
  tabId: string,
  expectedUrl: string,
  deadline: number,
  signal: AbortSignal,
  onNavigationLoad?: (iframe: HTMLIFrameElement) => void,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const ready = webPreviewIframe(workspaceId, threadId, tabId, expectedUrl);
  if (ready?.contentDocument?.readyState === "complete" && !onNavigationLoad) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let observedIframe: HTMLIFrameElement | null = null;
    let onLoad: (() => void) | null = null;
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (observedIframe && onLoad) observedIframe.removeEventListener("load", onLoad);
      observer.disconnect();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const observeReady = () => {
      const iframe = webPreviewIframe(workspaceId, threadId, tabId, expectedUrl);
      if (!iframe) return;
      if (iframe.contentDocument?.readyState === "complete" && !onNavigationLoad) return finish();
      if (observedIframe === iframe) return;
      if (observedIframe && onLoad) observedIframe.removeEventListener("load", onLoad);
      observedIframe = iframe;
      onLoad = () => {
        onNavigationLoad?.(iframe);
        finish();
      };
      iframe.addEventListener("load", onLoad, { once: true });
    };
    const observer = new MutationObserver(observeReady);
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Web Preview iframe did not attach before the request deadline"));
    }, Math.max(1, Math.min(60_000, deadline - Date.now())));
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "data-workspace-id", "data-scope-kind", "data-scope-id", "data-tab-id", "class", "style", "hidden", "aria-hidden"],
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    observeReady();
  });
}

/** Track a same-origin web navigation while its iframe revision advances. */
export interface WebNavigationExpectation {
  readonly targetKey: string;
  readonly expectedUrl: string;
  readonly initialRevision: number;
  loadObserved: boolean;
  acceptedRevision?: number;
}

function acceptsRecordedNavigationRevision(
  navigation: WebNavigationExpectation,
  target: { readonly revision: number } | undefined,
): number | undefined {
  return navigation.acceptedRevision === target?.revision ? navigation.acceptedRevision : undefined;
}

function matchesNavigationRevision(
  dispatch: BrowserAutomationHostDispatch,
  navigation: WebNavigationExpectation,
  target: { readonly revision: number } | undefined,
): boolean {
  const expectedUrl = normalizeWebPreviewUrl(dispatch.request.args.url ?? "");
  return navigation.targetKey === browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId) &&
    navigation.expectedUrl === expectedUrl &&
    dispatch.target.targetGeneration === navigation.initialRevision &&
    target?.revision === navigation.initialRevision + 1 &&
    Boolean(webPreviewIframe(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId, navigation.expectedUrl));
}

/** Accept the single expected target revision after a same-origin navigation. */
export function acceptExpectedWebNavigationRevision(
  dispatch: BrowserAutomationHostDispatch,
  navigation: WebNavigationExpectation | undefined,
  target: { readonly revision: number } | undefined,
): number | undefined {
  if (!navigation || (dispatch.request.operation !== "open" && dispatch.request.operation !== "navigate") || !navigation.loadObserved) return undefined;
  if (navigation.acceptedRevision !== undefined) return acceptsRecordedNavigationRevision(navigation, target);
  if (!matchesNavigationRevision(dispatch, navigation, target)) return undefined;
  navigation.acceptedRevision = target!.revision;
  return navigation.acceptedRevision;
}
