import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_FILE_ENTRIES = 32;

function readBounded(filePath) {
  const value = readFileSync(filePath, "utf8");
  if (Buffer.byteLength(value) > MAX_METADATA_BYTES) {
    throw new Error(
      `Electron update metadata exceeds ${MAX_METADATA_BYTES} bytes: ${filePath}`,
    );
  }
  return value;
}

function parseFileEntries(source) {
  const lines = source.split(/\r?\n/);
  const entries = [];
  let inFiles = false;
  let current = [];
  for (const line of lines) {
    if (line === "files:") {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    if (/^  - url:/.test(line)) {
      if (current.length > 0) entries.push(current.join("\n"));
      current = [line];
    } else if (/^    \S/.test(line) && current.length > 0) {
      current.push(line);
    } else if (/^\S/.test(line) && line.trim()) {
      break;
    } else if (current.length > 0) {
      current.push(line);
    }
    if (entries.length > MAX_FILE_ENTRIES)
      throw new Error("Electron update metadata has too many file entries");
  }
  if (current.length > 0) entries.push(current.join("\n").replace(/\n+$/, ""));
  if (entries.length === 0 || entries.length > MAX_FILE_ENTRIES) {
    throw new Error(
      "Electron update metadata must contain bounded file entries",
    );
  }
  return entries;
}

function entryUrl(entry) {
  const match = entry.match(/^  - url:\s*(\S+)\s*$/m);
  if (!match) throw new Error("Electron update metadata file entry has no URL");
  return match[1];
}

/** Merges architecture-specific electron-updater file entries into one metadata file. */
export function mergeElectronUpdateMetadata(
  primaryPath,
  secondaryPath,
  outputPath,
) {
  const primary = readBounded(primaryPath);
  const secondaryEntries = parseFileEntries(readBounded(secondaryPath));
  const primaryEntries = parseFileEntries(primary);
  const knownUrls = new Set(primaryEntries.map(entryUrl));
  const additions = secondaryEntries.filter(
    (entry) => !knownUrls.has(entryUrl(entry)),
  );
  if (additions.length === 0) {
    writeFileSync(outputPath, primary);
    return { added: 0 };
  }
  const lines = primary.split(/\r?\n/);
  const filesStart = lines.findIndex((line) => line === "files:");
  if (filesStart < 0)
    throw new Error("Electron update metadata has no files section");
  let insertAt = lines.length;
  for (let index = filesStart + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index]) && lines[index].trim()) {
      insertAt = index;
      break;
    }
  }
  lines.splice(insertAt, 0, ...additions.flatMap((entry) => entry.split("\n")));
  writeFileSync(outputPath, lines.join("\n"));
  return { added: additions.length };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const [primaryPath, secondaryPath, outputPath] = process.argv.slice(2);
  if (!primaryPath || !secondaryPath || !outputPath) {
    throw new Error(
      "Usage: merge-electron-update-metadata.mjs <primary> <secondary> <output>",
    );
  }
  mergeElectronUpdateMetadata(primaryPath, secondaryPath, outputPath);
}
