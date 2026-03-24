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
 * Extension-based icon color map.
 * Returns a Tailwind text-color class for the file type.
 */
const EXT_COLOR: Record<string, string> = {
  // JavaScript / TypeScript
  js: "text-yellow-400", jsx: "text-yellow-400", mjs: "text-yellow-400", cjs: "text-yellow-400",
  ts: "text-blue-400", tsx: "text-blue-400", mts: "text-blue-400", cts: "text-blue-400",
  // Web
  html: "text-orange-400", htm: "text-orange-400",
  vue: "text-emerald-400", svelte: "text-orange-500",
  // Styles
  css: "text-blue-300", scss: "text-pink-400", sass: "text-pink-400", less: "text-indigo-400",
  // Data / Config (JSON-like)
  json: "text-yellow-300", jsonc: "text-yellow-300", json5: "text-yellow-300",
  // Data / Config (YAML/TOML)
  yaml: "text-red-300", yml: "text-red-300", toml: "text-gray-400",
  // Markdown / Text
  md: "text-sky-300", mdx: "text-sky-300", txt: "text-gray-400", rst: "text-gray-400",
  // Python
  py: "text-yellow-300", pyi: "text-yellow-300", pyx: "text-yellow-300",
  // Rust
  rs: "text-orange-400",
  // Go
  go: "text-cyan-400",
  // C / C++
  c: "text-blue-300", h: "text-purple-300", cpp: "text-blue-400", hpp: "text-purple-400", cc: "text-blue-400",
  // Java / Kotlin
  java: "text-red-400", kt: "text-purple-400", kts: "text-purple-400",
  // Ruby
  rb: "text-red-400", rake: "text-red-400",
  // Shell
  sh: "text-emerald-400", bash: "text-emerald-400", zsh: "text-emerald-400",
  fish: "text-emerald-400", ps1: "text-blue-300", bat: "text-green-400", cmd: "text-green-400",
  // SQL / Database
  sql: "text-blue-300", sqlite: "text-blue-300", db: "text-blue-300",
  // Config
  env: "text-yellow-300", ini: "text-gray-400", cfg: "text-gray-400", conf: "text-gray-400",
  lock: "text-gray-500", editorconfig: "text-gray-400", gitignore: "text-gray-400",
  // Images
  png: "text-emerald-300", jpg: "text-emerald-300", jpeg: "text-emerald-300",
  gif: "text-emerald-300", svg: "text-orange-300", webp: "text-emerald-300",
  ico: "text-emerald-300", bmp: "text-emerald-300", avif: "text-emerald-300",
  // Video
  mp4: "text-purple-300", webm: "text-purple-300", avi: "text-purple-300", mov: "text-purple-300",
  // Audio
  mp3: "text-pink-300", wav: "text-pink-300", ogg: "text-pink-300", flac: "text-pink-300",
};

const NAME_COLOR: Record<string, string> = {
  dockerfile: "text-blue-400",
  makefile: "text-orange-400",
  ".gitignore": "text-gray-400",
  ".env": "text-yellow-300",
  ".env.local": "text-yellow-300",
  "tsconfig.json": "text-blue-400",
  "package.json": "text-emerald-400",
};

/**
 * Get a Tailwind text-color class for a file path based on its extension.
 */
export function getFileIconColor(filePath: string): string {
  const fileName = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
  const nameMatch = NAME_COLOR[fileName];
  if (nameMatch) return nameMatch;

  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx !== -1) {
    const ext = fileName.slice(dotIdx + 1);
    const extMatch = EXT_COLOR[ext];
    if (extMatch) return extMatch;
  }

  return "text-muted-foreground";
}

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
