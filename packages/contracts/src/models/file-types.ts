/**
 * Shared file type classification for attachment support.
 *
 * Uses file extensions (not MIME types) as the primary classifier because
 * browsers report empty or incorrect MIME types for most code files.
 */

/** File categories recognized by the attachment system. */
export type FileCategory = "image" | "pdf" | "text";

/** Size limits per category. */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
const MAX_PDF_SIZE = 32 * 1024 * 1024;
const MAX_TEXT_SIZE = 10 * 1024 * 1024;

/** Maximum number of attachments per message. */
export const MAX_ATTACHMENTS = 5;

/** Image extensions mapped to MIME types. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Text-based file extensions recognized by the system. */
const TEXT_EXTENSIONS = new Set([
  // Code
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "pyi", "go", "rs",
  "java", "kt", "scala", "c", "h", "cpp", "cc", "cxx", "hpp", "hxx",
  "cs", "fs", "fsx", "rb", "php", "swift", "m", "dart", "lua", "r",
  "jl", "ex", "exs", "erl", "hs", "clj", "cljs", "pl", "pm",
  "zig", "v", "nim", "sol",
  // Shell
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  // Web / Markup
  "html", "htm", "css", "scss", "sass", "less",
  "vue", "svelte", "astro", "xml", "xsl", "xslt", "svg",
  // Config / Data
  "json", "jsonc", "json5", "yaml", "yml", "toml",
  "ini", "cfg", "conf", "env", "properties",
  "csv", "tsv", "sql", "graphql", "gql",
  "prisma", "proto",
  // Docs
  "md", "mdx", "txt", "rst", "adoc", "org", "tex", "latex", "log",
  // Dev tools
  "diff", "patch",
  "tf", "hcl", "nix",
  "lock",
  // Dotfiles (after stripping leading dot)
  "gitignore", "gitattributes", "editorconfig",
  "eslintrc", "prettierrc", "dockerignore",
]);

/** Well-known filenames without extensions that are text files. */
const KNOWN_TEXT_FILENAMES = new Set([
  "Dockerfile", "Containerfile", "Makefile", "CMakeLists.txt",
  "Rakefile", "Justfile", "Gemfile", "Pipfile",
]);

/**
 * Extract the file extension from a filename (lowercased, no leading dot).
 * Returns empty string if the file has no extension.
 */
export function getExtension(fileName: string): string {
  // Handle dotfiles like ".gitignore" -> "gitignore"
  if (fileName.startsWith(".") && !fileName.includes(".", 1)) {
    return fileName.slice(1).toLowerCase();
  }
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return fileName.slice(dotIndex + 1).toLowerCase();
}

/**
 * Classify a file by its name into a category.
 * Returns null if the file type is not supported.
 */
export function classifyFile(fileName: string): FileCategory | null {
  const ext = getExtension(fileName);

  if (ext && ext in IMAGE_EXTENSIONS) return "image";
  if (ext === "pdf") return "pdf";
  if (ext && TEXT_EXTENSIONS.has(ext)) return "text";

  // Check well-known extensionless filenames
  if (KNOWN_TEXT_FILENAMES.has(fileName)) return "text";

  return null;
}

/**
 * Check whether a file is supported for attachment.
 */
export function isFileSupported(fileName: string): boolean {
  return classifyFile(fileName) !== null;
}

/**
 * Return the maximum allowed file size in bytes for a given filename.
 * Returns 0 for unsupported files.
 */
export function getMaxFileSize(fileName: string): number {
  const category = classifyFile(fileName);
  switch (category) {
    case "image": return MAX_IMAGE_SIZE;
    case "pdf": return MAX_PDF_SIZE;
    case "text": return MAX_TEXT_SIZE;
    default: return 0;
  }
}

/**
 * Infer a MIME type from a filename for storage/transport purposes.
 * Returns `"text/plain"` for all text-based files and an empty string
 * for unsupported files.
 */
export function inferMimeType(fileName: string): string {
  const ext = getExtension(fileName);

  if (ext && ext in IMAGE_EXTENSIONS) return IMAGE_EXTENSIONS[ext];
  if (ext === "pdf") return "application/pdf";

  // All recognized text-based extensions
  if ((ext && TEXT_EXTENSIONS.has(ext)) || KNOWN_TEXT_FILENAMES.has(fileName)) {
    return "text/plain";
  }

  return "";
}

/** The full set of supported extensions (for reference/docs only). */
export const SUPPORTED_EXTENSIONS = new Set([
  ...Object.keys(IMAGE_EXTENSIONS),
  "pdf",
  ...TEXT_EXTENSIONS,
]);
