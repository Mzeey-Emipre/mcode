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

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;

  if (req.type === "cancel") {
    if (activeRequestIds.has(req.id)) cancelledRequestIds.add(req.id);
    return;
  }

  if (req.type === "highlight") {
    const { id, code, language, theme } = req;
    const measured = req.measurePerformance === true;
    const firstMeasuredRequest = measured && !measuredWorkerRequestSeen;
    const workerRequestStartedAtMs = measured ? performance.now() : undefined;
    if (measured) {
      if (firstMeasuredRequest) measuredWorkerRequestSeen = true;
      measuredLanguages ??= new Set<string>();
    }
    try {
      const highlighterWasReady = measured && highlighterPromise !== null;
      let highlighterCreationStartedAtMs: number | null = null;
      const highlighter = await getHighlighter(
        measured
          ? (startedAtMs) => {
              highlighterCreationStartedAtMs = startedAtMs;
            }
          : undefined,
      );
      const highlighterCreationMs = measured
        ? boundedDuration(
            highlighterCreationStartedAtMs === null
              ? 0
              : performance.now() - highlighterCreationStartedAtMs,
          )
        : 0;
      const canonicalLanguage = measured ? resolveShikiLanguage(language) : "";
      const languageWasReady = measured && highlighter.getLoadedLanguages().includes(canonicalLanguage);
      const grammarLoadStartedAtMs = measured ? performance.now() : 0;
      const lang = await resolveLanguage(highlighter, language);
      const grammarLoadMs = measured ? boundedDuration(performance.now() - grammarLoadStartedAtMs) : 0;
      const phase = measured
        ? (highlighterWasReady && languageWasReady) || measuredLanguages!.has(lang)
          ? "warm"
          : "cold"
        : "warm";
      if (measured) measuredLanguages!.add(lang);

      let html: string;
      const codeToHtmlStartedAtMs = measured ? performance.now() : 0;
      try {
        html = highlighter.codeToHtml(code, { lang, theme });
      } catch {
        const escaped = code
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        html = `<pre class="shiki"><code>${escaped}</code></pre>`;
      }
      const codeToHtmlMs = measured ? boundedDuration(performance.now() - codeToHtmlStartedAtMs) : 0;

      const timing: ShikiWorkerTiming | undefined = measured
        ? {
            phase,
            workerStartupMs: boundedDuration(
              firstMeasuredRequest
                ? workerRequestStartedAtMs! - workerModuleStartedAtMs!
                : 0,
            ),
            highlighterCreationMs,
            grammarLoadMs,
            codeToHtmlMs,
            responseBytes: responseBytes(html),
            workerPostedAtEpochMs: Date.now(),
          }
        : undefined;

      self.postMessage({
        id,
        type: "highlight",
        html,
        ...(timing ? { timing } : {}),
      } satisfies HighlightResponse);
    } catch (err) {
      self.postMessage({
        id,
        type: "highlight",
        html: "",
        error: err instanceof Error ? err.message : "Unknown error",
      } satisfies HighlightResponse);
    }
    return;
  }

  if (req.type === "tokenize") {
    const { id, blocks } = req;
    try {
      const highlighter = await getHighlighter();
      const results: TokenizeResponse["results"] = [];

      for (const block of blocks) {
        try {
          const lang = await resolveLanguage(highlighter, block.language);
          const { tokens } = highlighter.codeToTokens(block.code, {
            lang,
            theme: block.theme,
          });
          // Map ThemedToken[][] → TokenSpan[][]
          const lines: TokenSpan[][] = tokens.map((lineTokens) =>
            lineTokens.map((t) => ({
              content: t.content,
              // Fall back to inherit so the diff text color applies
              color: t.color ?? "inherit",
            })),
          );
          results.push({ blockId: block.blockId, lines });
        } catch (err) {
          results.push({
            blockId: block.blockId,
            lines: [],
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }

      self.postMessage({ id, type: "tokenize", results } satisfies TokenizeResponse);
    } catch (err) {
      self.postMessage({
        id,
        type: "tokenize",
        results: [],
        error: err instanceof Error ? err.message : "Unknown error",
      } as TokenizeResponse & { error: string });
    }
    return;
  }

  if (req.type === "tokenize-diff-window") {
    const { id } = req;
    activeRequestIds.add(id);
    try {
      const totalLines = req.blocks.reduce(
        (count, block) => count + block.lines.length,
        0,
      );
      if (totalLines > PULL_REQUEST_DIFF_WORKER_MAX_LINES) {
        self.postMessage({
          id,
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
      for (const block of req.blocks) {
        await yieldToWorkerQueue();
        if (cancelledRequestIds.has(id)) return;
        if (block.lineKeys.length !== block.lines.length) {
          results.push({
            blockId: block.blockId,
            lineKeys: [],
            lines: [],
            truncatedLineKeys: [],
            tokenBytes: 0,
            error: "Pull request highlight line keys do not match source lines",
          });
          continue;
        }

        const truncatedLineKeys: string[] = [];
        const boundedLines = block.lines.map((line, index) => {
          const bounded = truncatePullRequestDiffLine(line);
          if (bounded.truncated) truncatedLineKeys.push(block.lineKeys[index]);
          return bounded.value;
        });
        try {
          const lang = await resolveLanguage(highlighter, block.language);
          if (cancelledRequestIds.has(id)) return;
          const { tokens } = highlighter.codeToTokens(boundedLines.join("\n"), {
            lang,
            theme: block.theme,
          });
          const lines = tokens.map((lineTokens) =>
            lineTokens.map((token) => ({
              content: token.content,
              color: token.color ?? "inherit",
            })),
          );
          const blockTokenBytes = tokenSpanBytes(lines);
          tokenBytes += blockTokenBytes;
          results.push({
            blockId: block.blockId,
            lineKeys: block.lineKeys,
            lines,
            truncatedLineKeys,
            tokenBytes: blockTokenBytes,
          });
        } catch (error) {
          results.push({
            blockId: block.blockId,
            lineKeys: block.lineKeys,
            lines: [],
            truncatedLineKeys,
            tokenBytes: 0,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
      if (cancelledRequestIds.has(id)) return;
      self.postMessage({
        id,
        type: "tokenize-diff-window",
        results,
        tokenBytes,
      } satisfies PullRequestDiffTokenizeResponse);
    } catch (error) {
      if (!cancelledRequestIds.has(id)) {
        self.postMessage({
          id,
          type: "tokenize-diff-window",
          results: [],
          tokenBytes: 0,
          error: error instanceof Error ? error.message : "Unknown error",
        } satisfies PullRequestDiffTokenizeResponse);
      }
    } finally {
      activeRequestIds.delete(id);
      cancelledRequestIds.delete(id);
    }
  }
};
