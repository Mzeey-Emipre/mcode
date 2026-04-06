/**
 * Maps a file path to a Shiki language identifier for syntax highlighting.
 * Returns "text" for unknown or unsupported file types.
 */

/** Maps file extensions (lowercase, no dot) to Shiki language names. */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "bash",
  bash: "bash",
  zsh: "shell",
  fish: "shell",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  c: "cpp",
  h: "cpp",
  hpp: "cpp",
  swift: "swift",
  php: "php",
  vue: "vue",
};

/** Maps exact basenames (for extension-less files) to Shiki language names. */
const BASENAME_TO_LANG: Record<string, string> = {
  Dockerfile: "dockerfile",
  dockerfile: "dockerfile",
  Makefile: "bash",
  makefile: "bash",
  ".bashrc": "bash",
  ".zshrc": "shell",
  ".profile": "bash",
};

/**
 * Returns the Shiki language name for the given file path.
 * Checks basename first (for extension-less files), then extension.
 */
export function langFromPath(filePath: string): string {
  const basename = filePath.split("/").pop() ?? filePath;

  // Check exact basename match first (Dockerfile, Makefile, etc.).
  // hasOwn avoids matching prototype-chain keys like "__proto__".
  if (Object.prototype.hasOwnProperty.call(BASENAME_TO_LANG, basename)) {
    return BASENAME_TO_LANG[basename];
  }

  // Extract extension
  const dot = basename.lastIndexOf(".");
  if (dot < 0) return "text";
  const ext = basename.slice(dot + 1).toLowerCase();

  return EXT_TO_LANG[ext] ?? "text";
}
