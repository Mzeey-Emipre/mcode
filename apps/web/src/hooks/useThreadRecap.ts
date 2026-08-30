import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getTransport } from "@/transport";
import type { Message } from "@/transport";
import { useThreadStore, type ThreadRecapCacheEntry } from "@/stores/threadStore";

const STALE_RECAP_MS = 5 * 60 * 1000;
const MIN_FILTERED_MESSAGES = 3;
const FIRST_RECAP_MESSAGE_LIMIT = 6;
const DELTA_RECAP_MESSAGE_LIMIT = 4;
const RECAP_MESSAGE_CONTENT_LIMIT = 600;

type ThreadRecapSource = "manual" | "automatic";

/** A persisted user or assistant message that can influence a thread Recap. */
export interface ThreadRecapMessage {
  /** Stable persisted message id. */
  id: string;
  /** Thread-local ordering used to make signatures deterministic. */
  sequence: number;
  /** Conversational role accepted by the recap RPC. */
  role: "user" | "assistant";
  /** Message body used for signature and bounded generation payloads. */
  content: string;
  /** Persisted timestamp used to determine whether the thread is stale. */
  timestamp: string;
}

/** In-flight or failed Recap request marker used by the scheduler. */
export interface ThreadRecapRequestMarker {
  /** Thread whose recap request is being tracked. */
  threadId: string;
  /** Deterministic signature for the filtered messages. */
  signature: string;
}

/** Inputs for deciding whether an automatic Recap generation should run. */
export interface ThreadRecapScheduleInput {
  /** Filtered persisted user and assistant messages. */
  messages: readonly ThreadRecapMessage[];
  /** Existing session-only cache entry for the thread, if any. */
  cached: ThreadRecapCacheEntry | undefined;
  /** Whether an agent turn is currently running for the thread. */
  isRunning: boolean;
  /** Current wall-clock time in milliseconds. */
  now: number;
  /** Stale threshold in milliseconds. */
  staleMs?: number;
  /** Current deterministic message signature. */
  signature: string;
  /** In-flight request marker to dedupe against. */
  inFlight?: ThreadRecapRequestMarker;
  /** Last failed automatic request marker. */
  lastFailed?: ThreadRecapRequestMarker;
  /** Whether this thread/signature already used its automatic session cap. */
  autoCapReached: boolean;
}

/** Result returned by {@link useThreadRecap}. */
export interface UseThreadRecapResult {
  /** Current session-cached recap text, if one exists. */
  recapText: string | null;
  /** Whether the cached recap covers an older eligible message than the latest one loaded. */
  hasCoverageGap: boolean;
  /** Timestamp of the message covered by the cached recap, if a gap is derivable. */
  coveredThrough: string | null;
  /** Timestamp of the latest eligible message, if a gap is derivable. */
  latestActivityAt: string | null;
  /** Whether generation is currently in flight for this thread/signature. */
  isGenerating: boolean;
  /** Last manual or automatic generation failure for the current thread. */
  error: string | null;
  /** Request a manual recap refresh, deduping only matching in-flight work. */
  refresh: () => Promise<void>;
}

const inFlightRequests = new Map<string, Promise<void>>();
const lastFailedByThread = new Map<string, ThreadRecapRequestMarker>();
const automaticRequests = new Set<string>();

/** Clears module-level Recap request guards for isolated unit tests. */
export function resetThreadRecapRequestStateForTest(): void {
  inFlightRequests.clear();
  lastFailedByThread.clear();
  automaticRequests.clear();
}

function requestKey(threadId: string, signature: string): string {
  return `${threadId}:${signature}`;
}

function getThreadStoreState(): ReturnType<typeof useThreadStore.getState> | null {
  const store = useThreadStore as typeof useThreadStore & {
    getState?: typeof useThreadStore.getState;
  };
  return typeof store.getState === "function" ? store.getState() : null;
}

function clipContent(content: string): string {
  return content.length > RECAP_MESSAGE_CONTENT_LIMIT
    ? content.slice(0, RECAP_MESSAGE_CONTENT_LIMIT)
    : content;
}

/**
 * Returns only persisted user and assistant messages that can affect a Recap.
 */
export function filterThreadRecapMessages(messages: readonly Message[]): ThreadRecapMessage[] {
  return messages
    .filter((message): message is Message & { role: "user" | "assistant" } =>
      (message.role === "user" || message.role === "assistant") &&
      message.is_internal !== true &&
      typeof message.id === "string" &&
      Number.isFinite(message.sequence) &&
      typeof message.content === "string",
    )
    .map((message) => ({
      id: message.id,
      sequence: message.sequence,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
    }))
    .sort((a, b) => a.sequence - b.sequence);
}

/**
 * Builds a deterministic Recap signature from message identity and content only.
 */
export function createThreadRecapSignature(messages: readonly ThreadRecapMessage[]): string {
  let hash = 2166136261;
  const update = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };

  for (const message of messages) {
    update(message.id);
    update("\u001f");
    update(String(message.sequence));
    update("\u001f");
    update(message.role);
    update("\u001f");
    update(message.content);
    update("\u001e");
  }

  return hash.toString(36);
}

/**
 * Returns whether the filtered conversation has enough substance for auto Recap.
 */
export function hasEnoughThreadRecapSubstance(
  messages: readonly ThreadRecapMessage[],
): boolean {
  return (
    messages.length >= MIN_FILTERED_MESSAGES &&
    messages.some((message) => message.role === "assistant")
  );
}

function isRecapScheduleBlocked(input: ThreadRecapScheduleInput): boolean {
  return (
    input.isRunning ||
    input.autoCapReached ||
    !hasEnoughThreadRecapSubstance(input.messages)
  );
}

function hasStaleLastRecapMessage(input: ThreadRecapScheduleInput, staleMs: number): boolean {
  const lastMessage = input.messages.at(-1);
  if (!lastMessage) return false;
  const lastMessageTime = Date.parse(lastMessage.timestamp);
  if (!Number.isFinite(lastMessageTime)) return false;
  return input.now - lastMessageTime >= staleMs;
}

function hasCurrentRecapRequest(input: ThreadRecapScheduleInput): boolean {
  return [input.cached, input.inFlight, input.lastFailed].some(
    (entry) => entry?.signature === input.signature,
  );
}

/**
 * Decides whether an automatic Recap generation should be scheduled.
 */
export function shouldScheduleThreadRecapGeneration(input: ThreadRecapScheduleInput): boolean {
  const staleMs = input.staleMs ?? STALE_RECAP_MS;
  if (isRecapScheduleBlocked(input)) return false;
  if (!hasStaleLastRecapMessage(input, staleMs)) return false;
  return !hasCurrentRecapRequest(input);
}

/**
 * Selects the bounded message payload for the recap RPC.
 */
export function buildThreadRecapPayload(
  messages: readonly ThreadRecapMessage[],
  cached: ThreadRecapCacheEntry | undefined,
): {
  messages: Array<{ id: string; role: "user" | "assistant"; content: string }>;
  previousRecap: string | null;
  coveredMessageId: string | null;
} {
  const selected = (() => {
    if (!cached) return messages.slice(-FIRST_RECAP_MESSAGE_LIMIT);
    const coveredIndex = messages.findIndex((message) => message.id === cached.coveredMessageId);
    const delta = coveredIndex >= 0 ? messages.slice(coveredIndex + 1) : messages;
    if (delta.length > 0) return delta.slice(-DELTA_RECAP_MESSAGE_LIMIT);
    return messages.slice(-1);
  })();
  const last = selected.at(-1);

  return {
    messages: selected.map((message) => ({
      id: message.id,
      role: message.role,
      content: clipContent(message.content),
    })),
    previousRecap: cached?.text ?? null,
    coveredMessageId: last?.id ?? null,
  };
}

/**
 * Derives whether cached recap coverage trails the latest loaded eligible message.
 */
export function getThreadRecapCoverageGap({
  messages,
  cached,
  signature,
}: {
  /** Filtered persisted user and assistant messages. */
  messages: readonly ThreadRecapMessage[];
  /** Existing session-only cache entry for the thread, if any. */
  cached: ThreadRecapCacheEntry | undefined;
  /** Current deterministic message signature. */
  signature: string;
}): Pick<UseThreadRecapResult, "hasCoverageGap" | "coveredThrough" | "latestActivityAt"> {
  const noGap = {
    hasCoverageGap: false,
    coveredThrough: null,
    latestActivityAt: null,
  };
  if (!cached) return noGap;
  if (cached.signature === signature) return noGap;

  const coveredIndex = messages.findIndex((message) => message.id === cached.coveredMessageId);
  const coveredMessage = coveredIndex >= 0 ? messages[coveredIndex] : undefined;
  const latestMessage = messages.at(-1);
  if (!coveredMessage || !latestMessage || coveredIndex >= messages.length - 1) return noGap;

  const coveredTime = Date.parse(coveredMessage.timestamp);
  const latestTime = Date.parse(latestMessage.timestamp);
  if (!Number.isFinite(coveredTime) || !Number.isFinite(latestTime)) return noGap;

  return {
    hasCoverageGap: true,
    coveredThrough: coveredMessage.timestamp,
    latestActivityAt: latestMessage.timestamp,
  };
}

type RecapGenerationState = {
  threadId: string;
  cached: ThreadRecapCacheEntry | undefined;
  messages: ThreadRecapMessage[];
  recordGeneration: ReturnType<typeof useThreadStore.getState>["recordThreadRecapGeneration"];
  signature: string;
  key: string;
};

function resolveRecapGenerationState(
  latestState: {
    threadId: string;
    cached: ThreadRecapCacheEntry | undefined;
    filteredMessages: ThreadRecapMessage[];
    recordThreadRecapGeneration: ReturnType<typeof useThreadStore.getState>["recordThreadRecapGeneration"];
  },
  messageOverride: readonly Message[] | undefined,
): RecapGenerationState {
  const storeState = getThreadStoreState();
  const messages = messageOverride
    ? filterThreadRecapMessages(messageOverride)
    : latestState.filteredMessages;
  const signature = createThreadRecapSignature(messages);
  return {
    threadId: latestState.threadId,
    cached: storeState?.recapByThread?.[latestState.threadId] ?? latestState.cached,
    messages,
    recordGeneration: latestState.recordThreadRecapGeneration,
    signature,
    key: requestKey(latestState.threadId, signature),
  };
}

function startAutomaticRecapIfScheduled(state: RecapGenerationState): boolean {
  const storeState = getThreadStoreState();
  const marker = { threadId: state.threadId, signature: state.signature };
  const shouldRun = shouldScheduleThreadRecapGeneration({
    messages: state.messages,
    cached: state.cached,
    isRunning: storeState?.runningThreadIds?.has(state.threadId) ?? false,
    now: Date.now(),
    signature: state.signature,
    inFlight: inFlightRequests.has(state.key) ? marker : undefined,
    lastFailed: lastFailedByThread.get(state.threadId),
    autoCapReached: automaticRequests.has(state.key),
  });
  if (shouldRun) automaticRequests.add(state.key);
  return shouldRun;
}

function createRecapRequest({
  state,
  source,
  payload,
  setError,
  setIsGenerating,
}: {
  state: RecapGenerationState;
  source: ThreadRecapSource;
  payload: ReturnType<typeof buildThreadRecapPayload> & { coveredMessageId: string };
  setError: (error: string | null) => void;
  setIsGenerating: (isGenerating: boolean) => void;
}): Promise<void> {
  return getTransport()
    .generateRecap(
      state.threadId,
      payload.messages.map(({ role, content }) => ({ role, content })),
      payload.previousRecap,
    )
    .then((result) => {
      state.recordGeneration({
        threadId: state.threadId,
        text: result.text,
        signature: state.signature,
        coveredMessageId: payload.coveredMessageId,
        generatedAt: new Date().toISOString(),
        source,
      });
      if (lastFailedByThread.get(state.threadId)?.signature === state.signature) {
        lastFailedByThread.delete(state.threadId);
      }
    })
    .catch((error: unknown) => {
      lastFailedByThread.set(state.threadId, {
        threadId: state.threadId,
        signature: state.signature,
      });
      setError(error instanceof Error ? error.message : "Recap unavailable");
    })
    .finally(() => {
      inFlightRequests.delete(state.key);
      setIsGenerating(false);
    });
}

function shouldGenerateRecapOnOverviewOpen(
  threadId: string,
  messages: readonly ThreadRecapMessage[],
  cached: ThreadRecapCacheEntry | undefined,
  signature: string,
): boolean {
  const storeState = getThreadStoreState();
  const key = requestKey(threadId, signature);
  return shouldScheduleThreadRecapGeneration({
    messages,
    cached: storeState?.recapByThread?.[threadId] ?? cached,
    isRunning: storeState?.runningThreadIds?.has(threadId) ?? false,
    now: Date.now(),
    signature,
    inFlight: inFlightRequests.has(key) ? { threadId, signature } : undefined,
    lastFailed: lastFailedByThread.get(threadId),
    autoCapReached: automaticRequests.has(key),
  });
}

/**
 * Generates and caches a thread Recap on manual refresh or stale re-orientation.
 */
export function useThreadRecap({
  threadId,
  messages,
  overviewOpen,
}: {
  /** Thread whose Recap should be managed. */
  threadId: string;
  /** Persisted messages available to the Overview. */
  messages: readonly Message[];
  /** Whether the Overview is open, used as a re-orientation signal. */
  overviewOpen: boolean;
}): UseThreadRecapResult {
  const filteredMessages = useMemo(() => filterThreadRecapMessages(messages), [messages]);
  const signature = useMemo(
    () => createThreadRecapSignature(filteredMessages),
    [filteredMessages],
  );
  const cached = useThreadStore((state) => state.recapByThread?.[threadId]);
  const coverageGap = useMemo(
    () => getThreadRecapCoverageGap({ messages: filteredMessages, cached, signature }),
    [cached, filteredMessages, signature],
  );
  const recordThreadRecapGeneration = useThreadStore((state) => state.recordThreadRecapGeneration);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestStateRef = useRef({
    threadId,
    cached,
    filteredMessages,
    recordThreadRecapGeneration,
  });
  latestStateRef.current = {
    threadId,
    cached,
    filteredMessages,
    recordThreadRecapGeneration,
  };

  const generate = useCallback(async (
    source: ThreadRecapSource,
    messageOverride?: readonly Message[],
  ) => {
    const state = resolveRecapGenerationState(latestStateRef.current, messageOverride);
    const existing = inFlightRequests.get(state.key);
    if (existing) {
      setIsGenerating(true);
      await existing.finally(() => setIsGenerating(false));
      return;
    }

    if (source === "automatic" && !startAutomaticRecapIfScheduled(state)) return;

    const payload = buildThreadRecapPayload(state.messages, state.cached);
    if (!payload.coveredMessageId || payload.messages.length === 0) return;

    setIsGenerating(true);
    setError(null);
    const promise = createRecapRequest({
      state,
      source,
      payload: { ...payload, coveredMessageId: payload.coveredMessageId },
      setError,
      setIsGenerating,
    });
    inFlightRequests.set(state.key, promise);
    await promise;
  }, []);

  const overviewOpenAutoAttemptedRef = useRef(false);
  useEffect(() => {
    if (!overviewOpen) {
      overviewOpenAutoAttemptedRef.current = false;
      return;
    }
    if (overviewOpenAutoAttemptedRef.current) return;

    if (!shouldGenerateRecapOnOverviewOpen(threadId, filteredMessages, cached, signature)) return;

    overviewOpenAutoAttemptedRef.current = true;
    void generate("automatic");
  }, [cached, filteredMessages, generate, overviewOpen, signature, threadId]);

  useEffect(() => {
    const onFocus = () => {
      const latestMessages = getThreadStoreState()?.records.get(threadId)?.messages ?? [];
      void generate("automatic", latestMessages);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [generate, threadId]);

  const previousThreadIdRef = useRef(threadId);
  useEffect(() => {
    if (previousThreadIdRef.current === threadId) return;
    previousThreadIdRef.current = threadId;
    const latestMessages = getThreadStoreState()?.records.get(threadId)?.messages ?? [];
    void generate("automatic", latestMessages);
  }, [generate, threadId]);

  return {
    recapText: cached?.text ?? null,
    ...coverageGap,
    isGenerating,
    error,
    refresh: useCallback(() => generate("manual"), [generate]),
  };
}
