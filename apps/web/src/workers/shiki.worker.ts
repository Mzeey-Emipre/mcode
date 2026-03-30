import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** Message sent from main thread to request highlighting. */
interface HighlightRequest {
  id: string;
  code: string;
  language: string;
  theme: "github-dark" | "github-light";
}

/** Message sent back from worker with highlighted HTML. */
interface HighlightResponse {
  id: string;
  html: string;
  error?: string;
}

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

self.onmessage = async (e: MessageEvent<HighlightRequest>) => {
  const { id, code, language, theme } = e.data;

  try {
    const highlighter = await getHighlighter();
    const loadedLangs = highlighter.getLoadedLanguages();
    let lang = language;

    if (!loadedLangs.includes(language)) {
      const importFn = LANG_IMPORTS[language];
      if (importFn) {
        // Coalesce concurrent loads for the same language via shared promise
        let loadPromise = languageLoading.get(language);
        if (!loadPromise) {
          loadPromise = importFn()
            .then((mod) =>
              highlighter.loadLanguage(mod.default as ShikiLang),
            )
            .finally(() => languageLoading.delete(language));
          languageLoading.set(language, loadPromise);
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

    // codeToHtml may throw if "text" is not a registered language in shiki/core.
    // Fall back to pre-escaped HTML in that case.
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

    self.postMessage({ id, html } satisfies HighlightResponse);
  } catch (err) {
    self.postMessage({
      id,
      html: "",
      error: err instanceof Error ? err.message : "Unknown error",
    } satisfies HighlightResponse);
  }
};
