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
  js: "text-amber-300/80", jsx: "text-amber-300/80", mjs: "text-amber-300/80", cjs: "text-amber-300/80",
  ts: "text-sky-400/80", tsx: "text-sky-400/80", mts: "text-sky-400/80", cts: "text-sky-400/80",
  // Web
  html: "text-orange-300/80", htm: "text-orange-300/80",
  vue: "text-emerald-400/70", svelte: "text-orange-400/70",
  // Styles
  css: "text-sky-300/80", scss: "text-pink-300/70", sass: "text-pink-300/70", less: "text-indigo-300/70",
  // Data / Config (JSON-like)
  json: "text-amber-200/70", jsonc: "text-amber-200/70", json5: "text-amber-200/70",
  // Data / Config (YAML/TOML)
  yaml: "text-rose-300/60", yml: "text-rose-300/60", toml: "text-zinc-400/70",
  // Markdown / Text
  md: "text-slate-400/80", mdx: "text-slate-400/80", txt: "text-zinc-400/60", rst: "text-zinc-400/60",
  // Python
  py: "text-sky-300/80", pyi: "text-sky-300/80", pyx: "text-sky-300/80",
  // Rust
  rs: "text-orange-300/70",
  // Go
  go: "text-cyan-300/70",
  // C / C++
  c: "text-sky-300/70", h: "text-violet-300/60", cpp: "text-sky-400/70", hpp: "text-violet-300/60", cc: "text-sky-400/70",
  // Java / Kotlin
  java: "text-orange-300/70", kt: "text-violet-300/70", kts: "text-violet-300/70",
  // Ruby
  rb: "text-rose-300/70", rake: "text-rose-300/70",
  // Shell
  sh: "text-emerald-300/70", bash: "text-emerald-300/70", zsh: "text-emerald-300/70",
  fish: "text-emerald-300/70", ps1: "text-sky-300/60", bat: "text-emerald-300/60", cmd: "text-emerald-300/60",
  // SQL / Database
  sql: "text-sky-300/60", sqlite: "text-sky-300/60", db: "text-sky-300/60",
  // Config
  env: "text-amber-200/60", ini: "text-zinc-400/60", cfg: "text-zinc-400/60", conf: "text-zinc-400/60",
  lock: "text-zinc-500/50", editorconfig: "text-zinc-400/60", gitignore: "text-zinc-400/60",
  // Images
  png: "text-teal-300/60", jpg: "text-teal-300/60", jpeg: "text-teal-300/60",
  gif: "text-teal-300/60", svg: "text-amber-300/60", webp: "text-teal-300/60",
  ico: "text-teal-300/60", bmp: "text-teal-300/60", avif: "text-teal-300/60",
  // Video
  mp4: "text-violet-300/60", webm: "text-violet-300/60", avi: "text-violet-300/60", mov: "text-violet-300/60",
  // Audio
  mp3: "text-pink-300/60", wav: "text-pink-300/60", ogg: "text-pink-300/60", flac: "text-pink-300/60",
};

const NAME_COLOR: Record<string, string> = {
  dockerfile: "text-sky-400/70",
  makefile: "text-orange-300/70",
  ".gitignore": "text-zinc-400/60",
  ".env": "text-amber-200/60",
  ".env.local": "text-amber-200/60",
  "tsconfig.json": "text-sky-400/70",
  "package.json": "text-emerald-300/70",
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
