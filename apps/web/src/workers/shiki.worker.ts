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

let highlighterPromise: ReturnType<typeof createHighlighterCore> | null = null;

/** Returns the singleton highlighter, creating it on first call. */
function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [
        import("shiki/themes/github-dark.mjs"),
        import("shiki/themes/github-light.mjs"),
      ],
      langs: [],
    });
  }
  return highlighterPromise;
}

/** In-progress language loads, keyed by language name. Prevents duplicate concurrent imports. */
const languageLoadPromises = new Map<string, Promise<boolean>>();

/** Dynamically imports a Shiki language grammar by name. Concurrent calls for the same language coalesce. */
async function loadLanguage(highlighter: Awaited<ReturnType<typeof createHighlighterCore>>, lang: string) {
  const loaded = highlighter.getLoadedLanguages();
  if (loaded.includes(lang)) return true;

  const existing = languageLoadPromises.get(lang);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const mod = await import(`shiki/langs/${lang}.mjs`);
      await highlighter.loadLanguage(mod.default ?? mod);
      return true;
    } catch {
      return false;
    } finally {
      languageLoadPromises.delete(lang);
    }
  })();

  languageLoadPromises.set(lang, promise);
  return promise;
}

self.onmessage = async (e: MessageEvent<HighlightRequest>) => {
  const { id, code, language, theme } = e.data;

  try {
    const highlighter = await getHighlighter();
    const langLoaded = await loadLanguage(highlighter, language);
    const lang = langLoaded ? language : "text";

    // Load "text" as fallback if needed
    if (!langLoaded) {
      await loadLanguage(highlighter, "text");
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
