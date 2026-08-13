/** Canonical Shiki language aliases accepted by Markdown code fences. */
export const SHIKI_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
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

/** Grammars that the Shiki worker can load on demand. */
export const SHIKI_SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "javascript",
  "json",
  "bash",
  "shell",
  "markdown",
  "python",
  "dockerfile",
  "yaml",
  "css",
  "html",
  "sql",
  "rust",
  "go",
  "diff",
  "toml",
  "java",
  "csharp",
  "php",
  "cpp",
  "swift",
  "kotlin",
  "vue",
]);

/** Resolves a Markdown fence language to the worker's canonical language. */
export function resolveShikiLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  if (normalized === "text" || normalized === "plaintext" || normalized === "plain") {
    return "text";
  }
  const resolved = SHIKI_LANGUAGE_ALIASES[normalized] ?? normalized;
  return SHIKI_SUPPORTED_LANGUAGES.has(resolved) ? resolved : "text";
}
