/**
 * File-type icon mapping based on extension.
 *
 * Returns a lucide-react icon component appropriate for the file extension.
 * Covers common web/backend languages, config files, and media types.
 * Falls back to a generic File icon for unrecognized extensions.
 */
import type { LucideIcon } from "lucide-react";
import {
  FileCode2,
  FileJson,
  FileText,
  FileImage,
  FileType,
  File,
  FileSpreadsheet,
  FileVideo,
  FileAudio,
  Cog,
  Database,
  Globe,
  Braces,
  Hash,
  Palette,
} from "lucide-react";

/**
 * Static extension → icon map.
 * Grouped by category for maintainability.
 */
const EXT_ICON: Record<string, LucideIcon> = {
  // JavaScript / TypeScript
  js: FileCode2, jsx: FileCode2, ts: FileCode2, tsx: FileCode2,
  mjs: FileCode2, cjs: FileCode2, mts: FileCode2, cts: FileCode2,
  // Web
  html: Globe, htm: Globe, vue: FileCode2, svelte: FileCode2,
  // Styles
  css: Palette, scss: Palette, sass: Palette, less: Palette,
  // Data / Config (JSON-like)
  json: FileJson, jsonc: FileJson, json5: FileJson,
  // Data / Config (YAML/TOML)
  yaml: Braces, yml: Braces, toml: Braces,
  // Markdown / Text
  md: FileText, mdx: FileText, txt: FileText, rst: FileText,
  // Python
  py: FileCode2, pyi: FileCode2, pyx: FileCode2,
  // Rust
  rs: FileCode2,
  // Go
  go: FileCode2,
  // C / C++
  c: FileCode2, h: FileCode2, cpp: FileCode2, hpp: FileCode2, cc: FileCode2,
  // Java / Kotlin
  java: FileCode2, kt: FileCode2, kts: FileCode2,
  // Ruby
  rb: FileCode2, rake: FileCode2,
  // Shell
  sh: Hash, bash: Hash, zsh: Hash, fish: Hash, ps1: Hash, bat: Hash, cmd: Hash,
  // SQL / Database
  sql: Database, sqlite: Database, db: Database,
  // Config
  env: Cog, ini: Cog, cfg: Cog, conf: Cog,
  lock: Cog, editorconfig: Cog, gitignore: Cog,
  // Fonts
  woff: FileType, woff2: FileType, ttf: FileType, otf: FileType, eot: FileType,
  // Images
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage,
  svg: FileImage, webp: FileImage, ico: FileImage, bmp: FileImage, avif: FileImage,
  // Video
  mp4: FileVideo, webm: FileVideo, avi: FileVideo, mov: FileVideo,
  // Audio
  mp3: FileAudio, wav: FileAudio, ogg: FileAudio, flac: FileAudio,
  // Spreadsheet
  csv: FileSpreadsheet, tsv: FileSpreadsheet, xls: FileSpreadsheet, xlsx: FileSpreadsheet,
};

/**
 * Well-known filenames that map to a specific icon regardless of extension.
 */
const NAME_ICON: Record<string, LucideIcon> = {
  dockerfile: Cog,
  makefile: Cog,
  rakefile: FileCode2,
  gemfile: FileCode2,
  procfile: Cog,
  ".gitignore": Cog,
  ".eslintrc": Cog,
  ".prettierrc": Cog,
  ".env": Cog,
  ".env.local": Cog,
  "tsconfig.json": FileJson,
  "package.json": FileJson,
};

/**
 * Get the icon component for a file path based on its extension or filename.
 */
export function getFileIcon(filePath: string): LucideIcon {
  // Check well-known filenames first (case-insensitive)
  const fileName = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
  const nameMatch = NAME_ICON[fileName];
  if (nameMatch) return nameMatch;

  // Extract extension
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx !== -1) {
    const ext = fileName.slice(dotIdx + 1);
    const extMatch = EXT_ICON[ext];
    if (extMatch) return extMatch;
  }

  return File;
}
