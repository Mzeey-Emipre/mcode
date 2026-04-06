import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** Highlight (codeToHtml) request — produces an HTML string. */
interface HighlightRequest {
  id: string;
  type: "highlight";
  code: string;
  language: string;
  theme: "github-dark" | "github-light";
}

/** Highlight response. */
interface HighlightResponse {
  id: string;
  type: "highlight";
  html: string;
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

type WorkerRequest = HighlightRequest | TokenizeRequest;

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

/**
 * Common markdown fence aliases mapped to their canonical Shiki language names.
 * Prevents common short-forms (e.g. `ts`, `py`) from silently falling back to plain text.
 */
const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  sh: "shell",
  zsh: "shell",
  yml: "yaml",
  cs: "csharp",
  "c++": "cpp",
  kt: "kotlin",
};

/** In-flight language load promises. Coalesces concurrent loads for the same language. */
const languageLoading = new Map<string, Promise<void>>();

let highlighterPromise: ReturnType<typeof createHighlighterCore> | null = null;

/**
 * Returns the singleton highlighter, creating it on first call.
 * Uses shiki/core with the JS RegExp engine (no WASM). Only themes load at
 * startup; grammars are imported on demand from @shikijs/langs.
 * If creation fails, the cached promise is cleared so the next request retries.
 */
function getHighlighter() {
  if (!highlighterPromise) {
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
  let lang = LANG_ALIASES[language] ?? language;
  const loadedLangs = highlighter.getLoadedLanguages();

  if (!loadedLangs.includes(lang)) {
    const importFn = LANG_IMPORTS[lang];
    if (importFn) {
      // Coalesce concurrent loads for the same language via shared promise
      let loadPromise = languageLoading.get(lang);
      if (!loadPromise) {
        loadPromise = importFn()
          .then((mod) => highlighter.loadLanguage(mod.default as ShikiLang))
          .finally(() => languageLoading.delete(lang));
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

  if (req.type === "highlight") {
    const { id, code, language, theme } = req;
    try {
      const highlighter = await getHighlighter();
      const lang = await resolveLanguage(highlighter, language);

      let html: string;
      try {
        html = highlighter.codeToHtml(code, { lang, theme });
      } catch {
        const escaped = code
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        html = `<pre class="shiki"><code>${escaped}</code></pre>`;
      }

      self.postMessage({ id, type: "highlight", html } satisfies HighlightResponse);
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
  }
};
