import {
  getWorker,
  nextRequestId,
  pending,
  workerGeneration,
  type WorkerResponse,
} from "./shiki-worker-client";
import { resolveShikiLanguage } from "./shiki-language";
import type { ShikiTheme } from "@/hooks/useTheme";

/** Maximum key and HTML bytes retained by the chat highlight cache. */
export const CHAT_HIGHLIGHT_MAX_CACHE_BYTES = 8 * 1024 * 1024;

/** Maximum retained bytes for one chat highlight result and its cache key. */
export const CHAT_HIGHLIGHT_MAX_CACHE_ENTRY_BYTES = 1 * 1024 * 1024;

/** Maximum queued or active chat highlight jobs retained by the coordinator. */
export const CHAT_HIGHLIGHT_MAX_PENDING_JOBS = 256;

/** Maximum UTF-8 source bytes posted to the chat highlight worker. */
export const CHAT_HIGHLIGHT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** Maximum active subscribers plus queued result deliveries retained globally. */
export const CHAT_HIGHLIGHT_MAX_TRACKED_SUBSCRIBERS = 512;

/** Minimal Worker contract used by the coordinator and its behavior tests. */
export interface ChatHighlightWorker {
  postMessage(message: ChatHighlightWorkerRequest): void;
}

/** Highlight request sent through the generic Shiki worker transport. */
export interface ChatHighlightWorkerRequest {
  id: string;
  type: "highlight";
  code: string;
  language: string;
  theme: ShikiTheme;
  measurePerformance?: boolean;
}

/** Highlight response delivered by the generic Shiki worker transport. */
export interface ChatHighlightResponse extends WorkerResponse {
  type: "highlight";
  html: string;
  timing?: unknown;
  error?: string;
}

/** Browser scheduling hooks used by the coordinator. */
export interface ChatHighlightScheduler {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  requestIdleCallback(callback: IdleRequestCallback): number;
  cancelIdleCallback(handle: number): void;
}

/** One settled chat code block request. */
export interface ChatHighlightRequest {
  code: string;
  language: string;
  theme: ShikiTheme;
  visible: boolean;
  measurePerformance?: boolean;
  onResult: (html: string | null, timing?: unknown) => void;
}

/** Handle returned to a CodeBlock so it can cancel work or update visibility. */
export interface ChatHighlightRequestHandle {
  cancel(): void;
  setVisible(visible: boolean): void;
}

/** Public coordinator contract for settled chat Markdown highlights. */
export interface ChatHighlightCoordinator {
  request(request: ChatHighlightRequest): ChatHighlightRequestHandle;
  getCacheBytes(): number;
  reset(): void;
}

interface CoordinatorDependencies {
  getWorker: () => ChatHighlightWorker;
  workerGeneration: () => number;
  pending: Map<string, (response: WorkerResponse | null) => void>;
  nextRequestId: (prefix: string) => string;
  scheduler: ChatHighlightScheduler;
}

interface CacheEntry {
  html: string;
  bytes: number;
  generation: number;
}

type SubscriberAccounting = "active" | "delivery" | "released";

interface Subscriber {
  active: boolean;
  visible: boolean;
  request: ChatHighlightRequest;
  accounting: SubscriberAccounting;
}

interface InFlightJob {
  key: string;
  code: string;
  language: string;
  theme: ShikiTheme;
  generation: number;
  subscribers: Set<Subscriber>;
  measurePerformance: boolean;
  started: boolean;
  epoch: number;
  requestId: string | null;
}

interface Delivery {
  subscriber: Subscriber;
  html: string | null;
  timing?: unknown;
}

const DEFAULT_SCHEDULER: ChatHighlightScheduler = {
  requestAnimationFrame: (callback) => requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
  requestIdleCallback: (callback) => {
    if (typeof globalThis.requestIdleCallback === "function") {
      return globalThis.requestIdleCallback(callback);
    }
    return globalThis.setTimeout(() => callback({
      didTimeout: true,
      timeRemaining: () => 0,
    }), 0) as unknown as number;
  },
  cancelIdleCallback: (handle) => {
    if (typeof globalThis.cancelIdleCallback === "function") {
      globalThis.cancelIdleCallback(handle);
      return;
    }
    globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  },
};

const DEFAULT_DEPENDENCIES: CoordinatorDependencies = {
  getWorker: () => getWorker(),
  workerGeneration: () => workerGeneration,
  pending,
  nextRequestId,
  scheduler: DEFAULT_SCHEDULER,
};

const MAX_VISIBLE_ACTIVE_JOBS = 4;

function byteLength(value: string): number {
  return typeof TextEncoder === "function"
    ? new TextEncoder().encode(value).byteLength
    : value.length * 2;
}

function keyFor(code: string, language: string, theme: ShikiTheme): string {
  return JSON.stringify([code, resolveShikiLanguage(language), theme]);
}

function parseWorkerResponse(
  value: WorkerResponse | null,
  expectedId: string,
): ChatHighlightResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.id !== expectedId
    || candidate.type !== "highlight"
    || typeof candidate.html !== "string"
    || (candidate.error !== undefined && typeof candidate.error !== "string")
  ) {
    return null;
  }
  return candidate as unknown as ChatHighlightResponse;
}

/** Creates a chat-only highlighter coordinator with explicit worker boundaries. */
export function createChatHighlightCoordinator(
  overrides: Partial<CoordinatorDependencies> = {},
): ChatHighlightCoordinator {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, InFlightJob>();
  const visibleQueue: InFlightJob[] = [];
  const offscreenQueue: InFlightJob[] = [];
  const deliveries: Delivery[] = [];
  let cacheBytes = 0;
  let activeJobs = 0;
  let trackedSubscribers = 0;
  let epoch = 0;
  let frameHandle: number | null = null;
  let idleHandle: number | null = null;

  const scheduleDelivery = (): void => {
    if (frameHandle !== null || deliveries.length === 0) return;
    frameHandle = dependencies.scheduler.requestAnimationFrame(() => {
      frameHandle = null;
      const delivery = deliveries.shift();
      if (delivery) {
        releaseSubscriber(delivery.subscriber);
      }
      if (delivery?.subscriber.active) {
        if (delivery.timing === undefined) {
          delivery.subscriber.request.onResult(delivery.html);
        } else {
          delivery.subscriber.request.onResult(delivery.html, delivery.timing);
        }
      }
      scheduleDelivery();
    });
  };

  const enqueueDelivery = (
    subscriber: Subscriber,
    html: string | null,
    timing?: unknown,
  ): void => {
    if (!subscriber.active) {
      releaseSubscriber(subscriber);
      return;
    }
    releaseSubscriber(subscriber);
    if (trackedSubscribers >= CHAT_HIGHLIGHT_MAX_TRACKED_SUBSCRIBERS) {
      subscriber.active = false;
      subscriber.request.onResult(null);
      return;
    }
    subscriber.accounting = "delivery";
    trackedSubscribers += 1;
    deliveries.push({ subscriber, html, timing });
    scheduleDelivery();
  };

  const cacheResult = (key: string, html: string, generation: number): void => {
    const htmlBytes = byteLength(html);
    const bytes = byteLength(key) + htmlBytes;
    if (bytes > CHAT_HIGHLIGHT_MAX_CACHE_ENTRY_BYTES) return;
    const previous = cache.get(key);
    if (previous) {
      cache.delete(key);
      cacheBytes -= previous.bytes;
    }
    cache.set(key, { html, bytes, generation });
    cacheBytes += bytes;
    while (cacheBytes > CHAT_HIGHLIGHT_MAX_CACHE_BYTES) {
      const oldest = cache.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) break;
      cache.delete(oldest[0]);
      cacheBytes -= oldest[1].bytes;
    }
  };

  const readCache = (key: string): string | null => {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.generation !== dependencies.workerGeneration()) {
      cache.delete(key);
      cacheBytes -= entry.bytes;
      return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.html;
  };

  const scheduleIdlePump = (): void => {
    if (idleHandle !== null || offscreenQueue.length === 0) return;
    idleHandle = dependencies.scheduler.requestIdleCallback(() => {
      idleHandle = null;
      if (activeJobs > 0 || visibleQueue.length > 0) {
        pump();
        return;
      }
      const offscreenJob = offscreenQueue.shift();
      if (offscreenJob) startJob(offscreenJob);
    });
  };

  const resolveHighlightedHtml = (
    response: ChatHighlightResponse | null,
    generation: number,
  ): string | null => {
    if (dependencies.workerGeneration() !== generation || !response || response.error) return null;
    return response.html || null;
  };

  const deliverJobResult = (
    subscribers: Iterable<Subscriber>,
    html: string | null,
    timing: unknown,
  ): void => {
    for (const subscriber of subscribers) {
      if (subscriber.active) enqueueDelivery(subscriber, html, timing);
    }
  };

  const finishJob = (job: InFlightJob, response: ChatHighlightResponse | null): void => {
    if (job.epoch !== epoch) return;
    activeJobs -= 1;
    inFlight.delete(job.key);
    const html = resolveHighlightedHtml(response, job.generation);
    if (response?.error) console.warn("[shiki-worker]", response.error);
    if (html !== null) cacheResult(job.key, html, job.generation);
    deliverJobResult(job.subscribers, html, response?.timing);
    job.subscribers.clear();
    pump();
  };

  const registerWorkerResponse = (job: InFlightJob, id: string): void => {
    dependencies.pending.set(id, (response) => {
      if (job.epoch !== epoch) return;
      dependencies.pending.delete(id);
      finishJob(job, parseWorkerResponse(response, id));
    });
  };

  const postHighlightRequest = (job: InFlightJob, id: string): void => {
    try {
      dependencies.getWorker().postMessage({
        id,
        type: "highlight",
        code: job.code,
        language: job.language,
        theme: job.theme,
        ...(job.measurePerformance ? { measurePerformance: true } : {}),
      });
    } catch {
      dependencies.pending.delete(id);
      finishJob(job, null);
    }
  };

  const startJob = (job: InFlightJob): void => {
    if (job.started) return;
    job.started = true;
    activeJobs += 1;
    const id = dependencies.nextRequestId("chat-highlight");
    job.requestId = id;
    registerWorkerResponse(job, id);
    postHighlightRequest(job, id);
  };

  function pump(): void {
    while (visibleQueue.length > 0 && activeJobs < MAX_VISIBLE_ACTIVE_JOBS) {
      const visibleJob = visibleQueue.shift();
      if (!visibleJob) break;
      startJob(visibleJob);
    }
    if (activeJobs > 0) {
      if (offscreenQueue.length > 0) scheduleIdlePump();
      return;
    }
    scheduleIdlePump();
  }

  const promote = (job: InFlightJob): void => {
    const index = offscreenQueue.indexOf(job);
    if (index >= 0) offscreenQueue.splice(index, 1);
    if (!visibleQueue.includes(job) && !job.started) visibleQueue.push(job);
    if (idleHandle !== null) {
      dependencies.scheduler.cancelIdleCallback(idleHandle);
      idleHandle = null;
    }
    pump();
  };

  const demote = (job: InFlightJob): void => {
    if (job.started) return;
    const index = visibleQueue.indexOf(job);
    if (index >= 0) visibleQueue.splice(index, 1);
    if (!offscreenQueue.includes(job)) offscreenQueue.push(job);
    pump();
  };

  const hasVisibleSubscriber = (job: InFlightJob): boolean =>
    Array.from(job.subscribers).some((subscriber) => subscriber.active && subscriber.visible);

  const reset = (): void => {
    epoch += 1;
    for (const job of inFlight.values()) {
      for (const subscriber of job.subscribers) {
        subscriber.active = false;
        releaseSubscriber(subscriber);
      }
      if (job.requestId && dependencies.pending.get(job.requestId)) {
        dependencies.pending.delete(job.requestId);
      }
    }
    for (const delivery of deliveries) releaseSubscriber(delivery.subscriber);
    cache.clear();
    inFlight.clear();
    visibleQueue.length = 0;
    offscreenQueue.length = 0;
    deliveries.length = 0;
    cacheBytes = 0;
    activeJobs = 0;
    trackedSubscribers = 0;
    if (frameHandle !== null) dependencies.scheduler.cancelAnimationFrame(frameHandle);
    if (idleHandle !== null) dependencies.scheduler.cancelIdleCallback(idleHandle);
    frameHandle = null;
    idleHandle = null;
  };

  function releaseSubscriber(subscriber: Subscriber): void {
    if (subscriber.accounting === "released") return;
    trackedSubscribers -= 1;
    subscriber.accounting = "released";
  }

  function reserveSubscriber(subscriber: Subscriber): boolean {
    if (trackedSubscribers >= CHAT_HIGHLIGHT_MAX_TRACKED_SUBSCRIBERS) return false;
    trackedSubscribers += 1;
    subscriber.accounting = "active";
    return true;
  }

  const createHandle = (
    subscriber: Subscriber,
    key: string,
  ): ChatHighlightRequestHandle => ({
    cancel(): void {
      if (!subscriber.active && subscriber.accounting === "released") return;
      subscriber.active = false;
      subscriber.request.onResult = () => undefined;
      releaseSubscriber(subscriber);
      const job = inFlight.get(key);
      if (job?.subscribers.has(subscriber)) {
        job.subscribers.delete(subscriber);
        if (!job.started) {
          if (job.subscribers.size === 0) {
            inFlight.delete(key);
            const visibleIndex = visibleQueue.indexOf(job);
            if (visibleIndex >= 0) visibleQueue.splice(visibleIndex, 1);
            const offscreenIndex = offscreenQueue.indexOf(job);
            if (offscreenIndex >= 0) offscreenQueue.splice(offscreenIndex, 1);
            pump();
          } else if (!hasVisibleSubscriber(job)) {
            demote(job);
          }
        }
      }
    },
    setVisible(visible): void {
      if (!subscriber.active || subscriber.visible === visible) return;
      subscriber.visible = visible;
      const job = inFlight.get(key);
      if (!job || job.started) return;
      if (visible) promote(job);
      else if (!hasVisibleSubscriber(job)) demote(job);
    },
  });

  return {
    request(request): ChatHighlightRequestHandle {
      if (byteLength(request.code) > CHAT_HIGHLIGHT_MAX_SOURCE_BYTES) {
        request.onResult(null);
        return { cancel(): void {}, setVisible(): void {} };
      }
      const language = resolveShikiLanguage(request.language);
      const key = keyFor(request.code, language, request.theme);
      const subscriber: Subscriber = {
        active: true,
        visible: request.visible,
        request,
        accounting: "released",
      };
      if (!reserveSubscriber(subscriber)) {
        request.onResult(null);
        return { cancel(): void {}, setVisible(): void {} };
      }
      const cached = readCache(key);
      if (cached !== null) {
        enqueueDelivery(subscriber, cached);
      } else {
        let job = inFlight.get(key);
        if (!job) {
          if (inFlight.size >= CHAT_HIGHLIGHT_MAX_PENDING_JOBS) {
            enqueueDelivery(subscriber, null);
            return createHandle(subscriber, key);
          }
          job = {
            key,
            code: request.code,
            language,
            theme: request.theme,
            generation: dependencies.workerGeneration(),
            subscribers: new Set(),
            measurePerformance: request.measurePerformance === true,
            started: false,
            epoch,
            requestId: null,
          };
          inFlight.set(key, job);
          (request.visible ? visibleQueue : offscreenQueue).push(job);
        } else if (!job.started) {
          job.measurePerformance ||= request.measurePerformance === true;
        }
        job.subscribers.add(subscriber);
        if (request.visible) promote(job);
        else pump();
      }

      return createHandle(subscriber, key);
    },
    getCacheBytes: () => cacheBytes,
    reset,
  };
}

/** Singleton coordinator used by settled chat Markdown code blocks. */
export const chatHighlightCoordinator = createChatHighlightCoordinator();

/** Clears chat highlight cache and pending state at a performance cold-cycle boundary. */
export function resetChatHighlightCoordinator(): void {
  chatHighlightCoordinator.reset();
}
