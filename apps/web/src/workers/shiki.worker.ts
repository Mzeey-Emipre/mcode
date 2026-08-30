import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import {
  MAX_SHIKI_PERFORMANCE_DURATION_MS,
  MAX_SHIKI_PERFORMANCE_RESPONSE_BYTES,
  type ShikiWorkerTiming,
} from "@/performance/shiki-performance-contract";
import { resolveShikiLanguage } from "@/lib/shiki-language";

const performanceBuild =
  import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "profiling" ||
  import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "production";

// The worker contract is the producer; runner validation mirrors this serialized boundary.
const workerModuleStartedAtMs = performanceBuild ? performance.now() : undefined;
let measuredWorkerRequestSeen = false;
let measuredLanguages: Set<string> | undefined;

/** Highlight (codeToHtml) request — produces an HTML string. */
interface HighlightRequest {
  id: string;
  type: "highlight";
  code: string;
  language: string;
  theme: "github-dark" | "github-light";
  measurePerformance?: boolean;
}

/** Highlight response. */
interface HighlightResponse {
  id: string;
  type: "highlight";
  html: string;
  timing?: ShikiWorkerTiming;
  error?: string;
}

/** A single syntax token with its display color. */
export interface TokenSpan {
  content: string;
  color: string;
}

/** Tokenize (codeToTokens) request — produces per-line token arrays for diff highlighting. */
interface TokenizeRequest {
  id: string;
  type: "tokenize";
  blocks: Array<{
    blockId: string;
    code: string;
    language: string;
    theme: "github-dark" | "github-light";
  }>;
}

/** Tokenize response. */
interface TokenizeResponse {
  id: string;
  type: "tokenize";
  results: Array<{
    blockId: string;
    lines: TokenSpan[][];
    error?: string;
  }>;
}

/** Maximum source lines accepted by one pull request diff highlighting job. */
export const PULL_REQUEST_DIFF_WORKER_MAX_LINES = 512;

/** Maximum UTF-8 bytes retained from one remote patch line before tokenization. */
export const PULL_REQUEST_DIFF_WORKER_MAX_LINE_LENGTH = 16 * 1_024;

function truncatePullRequestDiffLine(line: string): {
  value: string;
  truncated: boolean;
} {
  let bytes = 0;
  let codeUnits = 0;
  for (const character of line) {
    const codePoint = character.codePointAt(0) ?? 0;
    const characterBytes =
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (bytes + characterBytes > PULL_REQUEST_DIFF_WORKER_MAX_LINE_LENGTH) {
      return { value: line.slice(0, codeUnits), truncated: true };
    }
    bytes += characterBytes;
    codeUnits += character.length;
  }
  return { value: line, truncated: false };
}

/** One coherent visible-hunk block sent to the worker for pull request highlighting. */
export interface PullRequestDiffTokenizeBlock {
  blockId: string;
  lineKeys: string[];
  lines: string[];
  language: string;
  theme: "github-dark" | "github-light";
}

/** Cancellable, visible-window pull request diff tokenization request. */
export interface PullRequestDiffTokenizeRequest {
  id: string;
  type: "tokenize-diff-window";
  blocks: PullRequestDiffTokenizeBlock[];
}

/** Pull request diff tokenization result with cache-byte accounting. */
export interface PullRequestDiffTokenizeResponse {
  id: string;
  type: "tokenize-diff-window";
  results: Array<{
    blockId: string;
    lineKeys: string[];
    lines: TokenSpan[][];
    truncatedLineKeys: string[];
    tokenBytes: number;
    error?: string;
  }>;
  tokenBytes: number;
  error?: string;
}

interface CancelRequest {
  type: "cancel";
  id: string;
}

type WorkerRequest =
  | HighlightRequest
  | TokenizeRequest
  | PullRequestDiffTokenizeRequest
  | CancelRequest;

/** Shiki language parameter type derived from the core highlighter's loadLanguage signature. */
type ShikiLang = Parameters<
  Awaited<ReturnType<typeof createHighlighterCore>>["loadLanguage"]
>[0];

/**
 * Explicit grammar imports for languages commonly seen in agent output.
 * Each entry is a lazy import so the bundler code-splits grammars into
 * separate chunks. Languages not in this map fall back to plain text.
 * Adding a new language is a one-line addition.
 */
const LANG_IMPORTS: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  bash: () => import("@shikijs/langs/bash"),
  shell: () => import("@shikijs/langs/shell"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  yaml: () => import("@shikijs/langs/yaml"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  sql: () => import("@shikijs/langs/sql"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  diff: () => import("@shikijs/langs/diff"),
  toml: () => import("@shikijs/langs/toml"),
  java: () => import("@shikijs/langs/java"),
  csharp: () => import("@shikijs/langs/csharp"),
  php: () => import("@shikijs/langs/php"),
  cpp: () => import("@shikijs/langs/cpp"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  vue: () => import("@shikijs/langs/vue"),
};

/** In-flight language load promises. Coalesces concurrent loads for the same language. */
const languageLoading = new Map<string, Promise<void>>();

let highlighterPromise: ReturnType<typeof createHighlighterCore> | null = null;
const activeRequestIds = new Set<string>();
const cancelledRequestIds = new Set<string>();

function yieldToWorkerQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function boundedDuration(value: number): number {
  return Math.max(0, Math.min(MAX_SHIKI_PERFORMANCE_DURATION_MS, value));
}

function responseBytes(value: string): number {
  return Math.min(MAX_SHIKI_PERFORMANCE_RESPONSE_BYTES, new TextEncoder().encode(value).byteLength);
}

function tokenSpanBytes(lines: readonly TokenSpan[][]): number {
  let bytes = 0;
  for (const line of lines) {
    for (const token of line) {
      bytes += (token.content.length + token.color.length) * 2 + 32;
    }
  }
  return bytes;
}

/**
 * Returns the singleton highlighter, creating it on first call.
 * Uses shiki/core with the JS RegExp engine (no WASM). Only themes load at
 * startup; grammars are imported on demand from @shikijs/langs.
 * If creation fails, the cached promise is cleared so the next request retries.
 */
function getHighlighter(onCreate?: (startedAtMs: number) => void) {
  if (!highlighterPromise) {
    onCreate?.(performance.now());
    highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [
        import("@shikijs/themes/github-dark"),
        import("@shikijs/themes/github-light"),
      ],
      langs: [],
    }).catch((err) => {
      highlighterPromise = null;
      throw err;
    });
  }
  return highlighterPromise;
}

/**
 * Resolves language alias and ensures the grammar is loaded.
 * Returns the resolved language name, falling back to "text" on failure.
 */
async function resolveLanguage(
  highlighter: Awaited<ReturnType<typeof createHighlighterCore>>,
  language: string,
): Promise<string> {
  let lang = resolveShikiLanguage(language);
  const loadedLangs = highlighter.getLoadedLanguages();

  if (!loadedLangs.includes(lang)) {
    const importFn = LANG_IMPORTS[lang];
    if (importFn) {
      // Coalesce concurrent loads for the same language via shared promise
      let loadPromise = languageLoading.get(lang);
      if (!loadPromise) {
        loadPromise = (async () => {
          try {
            const mod = await importFn();
            await highlighter.loadLanguage(mod.default as ShikiLang);
          } finally {
            languageLoading.delete(lang);
          }
        })();
        languageLoading.set(lang, loadPromise);
      }
      try {
        await loadPromise;
      } catch {
        lang = "text";
      }
    } else {
      lang = "text";
    }
  }
  return lang;
}

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;
type PullRequestDiffTokenizeResult = PullRequestDiffTokenizeResponse["results"][number];

type HighlightMeasurement = {
  measured: boolean;
  firstMeasuredRequest: boolean;
  workerRequestStartedAtMs: number | undefined;
  highlighterCreationStartedAtMs: number | null;
};

function beginHighlightMeasurement(request: HighlightRequest): HighlightMeasurement {
  const measured = request.measurePerformance === true;
  const firstMeasuredRequest = measured && !measuredWorkerRequestSeen;
  if (measured) {
    if (firstMeasuredRequest) measuredWorkerRequestSeen = true;
    measuredLanguages ??= new Set<string>();
  }
  return {
    measured,
    firstMeasuredRequest,
    workerRequestStartedAtMs: measured ? performance.now() : undefined,
    highlighterCreationStartedAtMs: null,
  };
}

function getHighlightPhase(
  measured: boolean,
  highlighterWasReady: boolean,
  languageWasReady: boolean,
  language: string,
): "warm" | "cold" {
  if (!measured) return "warm";
  return (highlighterWasReady && languageWasReady) || measuredLanguages!.has(language)
    ? "warm"
    : "cold";
}

async function resolveMeasuredLanguage(
  highlighter: Highlighter,
  language: string,
  measured: boolean,
): Promise<{ language: string; wasReady: boolean; loadMs: number }> {
  const canonicalLanguage = measured ? resolveShikiLanguage(language) : "";
  const wasReady = measured && highlighter.getLoadedLanguages().includes(canonicalLanguage);
  const startedAtMs = measured ? performance.now() : 0;
  const resolvedLanguage = await resolveLanguage(highlighter, language);
  return {
    language: resolvedLanguage,
    wasReady,
    loadMs: measured ? boundedDuration(performance.now() - startedAtMs) : 0,
  };
}

function renderHighlightHtml(
  highlighter: Highlighter,
  code: string,
  language: string,
  theme: HighlightRequest["theme"],
): string {
  try {
    return highlighter.codeToHtml(code, { lang: language, theme });
  } catch {
    const escaped = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<pre class="shiki"><code>${escaped}</code></pre>`;
  }
}

function createHighlightTiming(
  measurement: HighlightMeasurement,
  highlighterCreationMs: number,
  grammarLoadMs: number,
  codeToHtmlMs: number,
  html: string,
  phase: "warm" | "cold",
): ShikiWorkerTiming | undefined {
  if (!measurement.measured) return undefined;
  return {
    phase,
    workerStartupMs: boundedDuration(
      measurement.firstMeasuredRequest
        ? measurement.workerRequestStartedAtMs! - workerModuleStartedAtMs!
        : 0,
    ),
    highlighterCreationMs,
    grammarLoadMs,
    codeToHtmlMs,
    responseBytes: responseBytes(html),
    workerPostedAtEpochMs: Date.now(),
  };
}

async function createHighlightResponse(request: HighlightRequest): Promise<HighlightResponse> {
  const measurement = beginHighlightMeasurement(request);
  const highlighterWasReady = measurement.measured && highlighterPromise !== null;
  const highlighter = await getHighlighter((startedAtMs) => {
    measurement.highlighterCreationStartedAtMs = startedAtMs;
  });
  const highlighterCreationMs = measurement.measured
    ? boundedDuration(
        measurement.highlighterCreationStartedAtMs === null
          ? 0
          : performance.now() - measurement.highlighterCreationStartedAtMs,
      )
    : 0;
  const language = await resolveMeasuredLanguage(highlighter, request.language, measurement.measured);
  const phase = getHighlightPhase(
    measurement.measured,
    highlighterWasReady,
    language.wasReady,
    language.language,
  );
  if (measurement.measured) measuredLanguages!.add(language.language);
  const startedAtMs = measurement.measured ? performance.now() : 0;
  const html = renderHighlightHtml(highlighter, request.code, language.language, request.theme);
  const codeToHtmlMs = measurement.measured
    ? boundedDuration(performance.now() - startedAtMs)
    : 0;
  const timing = createHighlightTiming(
    measurement,
    highlighterCreationMs,
    language.loadMs,
    codeToHtmlMs,
    html,
    phase,
  );
  return {
    id: request.id,
    type: "highlight",
    html,
    ...(timing ? { timing } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function tokenSpans(tokens: ReturnType<Highlighter["codeToTokens"]>["tokens"]): TokenSpan[][] {
  return tokens.map((lineTokens) =>
    lineTokens.map((token) => ({
      content: token.content,
      color: token.color ?? "inherit",
    })),
  );
}

async function tokenizeBlock(
  highlighter: Highlighter,
  block: TokenizeRequest["blocks"][number],
): Promise<TokenizeResponse["results"][number]> {
  try {
    const language = await resolveLanguage(highlighter, block.language);
    const { tokens } = highlighter.codeToTokens(block.code, { lang: language, theme: block.theme });
    return { blockId: block.blockId, lines: tokenSpans(tokens) };
  } catch (error) {
    return { blockId: block.blockId, lines: [], error: errorMessage(error) };
  }
}

async function handleHighlightRequest(request: HighlightRequest): Promise<void> {
  try {
    self.postMessage(await createHighlightResponse(request));
  } catch (error) {
    self.postMessage({
      id: request.id,
      type: "highlight",
      html: "",
      error: errorMessage(error),
    } satisfies HighlightResponse);
  }
}

async function handleTokenizeRequest(request: TokenizeRequest): Promise<void> {
  try {
    const highlighter = await getHighlighter();
    const results: TokenizeResponse["results"] = [];
    for (const block of request.blocks) results.push(await tokenizeBlock(highlighter, block));
    self.postMessage({ id: request.id, type: "tokenize", results } satisfies TokenizeResponse);
  } catch (error) {
    self.postMessage({
      id: request.id,
      type: "tokenize",
      results: [],
      error: errorMessage(error),
    } as TokenizeResponse & { error: string });
  }
}

function hasDiffWindowLineCapacity(request: PullRequestDiffTokenizeRequest): boolean {
  return request.blocks.reduce((count, block) => count + block.lines.length, 0) <= PULL_REQUEST_DIFF_WORKER_MAX_LINES;
}

function boundDiffBlockLines(block: PullRequestDiffTokenizeBlock): {
  lines: string[];
  truncatedLineKeys: string[];
} {
  const truncatedLineKeys: string[] = [];
  const lines = block.lines.map((line, index) => {
    const bounded = truncatePullRequestDiffLine(line);
    if (bounded.truncated) truncatedLineKeys.push(block.lineKeys[index]);
    return bounded.value;
  });
  return { lines, truncatedLineKeys };
}

function diffBlockError(
  block: PullRequestDiffTokenizeBlock,
  message: string,
): PullRequestDiffTokenizeResult {
  return {
    blockId: block.blockId,
    lineKeys: [],
    lines: [],
    truncatedLineKeys: [],
    tokenBytes: 0,
    error: message,
  };
}

async function tokenizeDiffWindowBlock(
  highlighter: Highlighter,
  block: PullRequestDiffTokenizeBlock,
  requestId: string,
): Promise<PullRequestDiffTokenizeResult | undefined> {
  await yieldToWorkerQueue();
  if (cancelledRequestIds.has(requestId)) return undefined;
  if (block.lineKeys.length !== block.lines.length) {
    return diffBlockError(block, "Pull request highlight line keys do not match source lines");
  }
  const bounded = boundDiffBlockLines(block);
  try {
    const language = await resolveLanguage(highlighter, block.language);
    if (cancelledRequestIds.has(requestId)) return undefined;
    const { tokens } = highlighter.codeToTokens(bounded.lines.join("\n"), {
      lang: language,
      theme: block.theme,
    });
    const lines = tokenSpans(tokens);
    return {
      blockId: block.blockId,
      lineKeys: block.lineKeys,
      lines,
      truncatedLineKeys: bounded.truncatedLineKeys,
      tokenBytes: tokenSpanBytes(lines),
    };
  } catch (error) {
    return {
      blockId: block.blockId,
      lineKeys: block.lineKeys,
      lines: [],
      truncatedLineKeys: bounded.truncatedLineKeys,
      tokenBytes: 0,
      error: errorMessage(error),
    };
  }
}

async function handleDiffWindowTokenizeRequest(
  request: PullRequestDiffTokenizeRequest,
): Promise<void> {
  activeRequestIds.add(request.id);
  try {
    if (!hasDiffWindowLineCapacity(request)) {
      self.postMessage({
        id: request.id,
        type: "tokenize-diff-window",
        results: [],
        tokenBytes: 0,
        error: "Pull request highlight window exceeds the worker line limit",
      } satisfies PullRequestDiffTokenizeResponse);
      return;
    }
    const highlighter = await getHighlighter();
    const results: PullRequestDiffTokenizeResponse["results"] = [];
    let tokenBytes = 0;
    for (const block of request.blocks) {
      const result = await tokenizeDiffWindowBlock(highlighter, block, request.id);
      if (!result) return;
      results.push(result);
      tokenBytes += result.tokenBytes;
    }
    if (cancelledRequestIds.has(request.id)) return;
    self.postMessage({
      id: request.id,
      type: "tokenize-diff-window",
      results,
      tokenBytes,
    } satisfies PullRequestDiffTokenizeResponse);
  } catch (error) {
    if (!cancelledRequestIds.has(request.id)) {
      self.postMessage({
        id: request.id,
        type: "tokenize-diff-window",
        results: [],
        tokenBytes: 0,
        error: errorMessage(error),
      } satisfies PullRequestDiffTokenizeResponse);
    }
  } finally {
    activeRequestIds.delete(request.id);
    cancelledRequestIds.delete(request.id);
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;

  if (req.type === "cancel") {
    if (activeRequestIds.has(req.id)) cancelledRequestIds.add(req.id);
    return;
  }

  if (req.type === "highlight") {
    await handleHighlightRequest(req);
    return;
  }

  if (req.type === "tokenize") {
    await handleTokenizeRequest(req);
    return;
  }

  if (req.type === "tokenize-diff-window") {
    await handleDiffWindowTokenizeRequest(req);
  }
};
