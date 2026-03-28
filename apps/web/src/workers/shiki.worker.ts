import { createHighlighter } from "shiki/bundle/full";
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

/** Shiki language parameter type extracted from the bundle's loadLanguage signature. */
type ShikiLang = Parameters<Awaited<ReturnType<typeof createHighlighter>>["loadLanguage"]>[0];

/** In-flight language load promises, keyed by language name. Coalesces concurrent loads for the same language. */
const languageLoading = new Map<string, Promise<void>>();

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null;

/**
 * Returns the singleton highlighter, creating it on first call.
 * Uses shiki/bundle/full for broad language coverage (~200 languages) with the
 * JS RegExp engine (no WASM binary, ~4% the size of Oniguruma).
 * If creation fails, the cached promise is cleared so the next request retries.
 */
function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      engine: createJavaScriptRegexEngine(),
      themes: ["github-dark", "github-light"],
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

    // Load language on demand. shiki/bundle/full resolves these via static
    // imports so Vite can bundle them. Unknown languages throw and we fall back.
    const loadedLangs = highlighter.getLoadedLanguages();
    let lang = language;

    if (!loadedLangs.includes(language)) {
      // Coalesce concurrent loads for the same language via shared promise
      let loadPromise = languageLoading.get(language);
      if (!loadPromise) {
        loadPromise = highlighter
          .loadLanguage(language as ShikiLang)
          .finally(() => languageLoading.delete(language));
        languageLoading.set(language, loadPromise);
      }
      try {
        await loadPromise;
      } catch {
        lang = "text";
        if (!highlighter.getLoadedLanguages().includes("text")) {
          await highlighter.loadLanguage("text" as ShikiLang);
        }
      }
    }

    const html = highlighter.codeToHtml(code, { lang, theme });

    self.postMessage({ id, html } satisfies HighlightResponse);
  } catch (err) {
    self.postMessage({
      id,
      html: "",
      error: err instanceof Error ? err.message : "Unknown error",
    } satisfies HighlightResponse);
  }
};
