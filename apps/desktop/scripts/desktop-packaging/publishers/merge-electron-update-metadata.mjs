import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_FILE_ENTRIES = 32;

function readBounded(filePath) {
  const value = NodeFS.readFileSync(filePath, "utf8");
  if (Buffer.byteLength(value) > MAX_METADATA_BYTES) {
    throw new Error(
      `Electron update metadata exceeds ${MAX_METADATA_BYTES} bytes: ${filePath}`,
    );
  }
  return value;
}

function parseFileEntries(source) {
  if (typeof source !== "string") {
    throw new TypeError("Electron update metadata must be text");
  }
  return collectFileEntries(source.split(/\r?\n/));
}

function collectFileEntries(lines) {
  const entries = [];
  const fileLines = lines.slice(findFilesSectionStart(lines) + 1);
  let current = collectCurrentFileEntry(fileLines, entries);
  if (current.length > 0) entries.push(current.join("\n").replace(/\n+$/, ""));
  return assertFileEntries(entries);
}

function findFilesSectionStart(lines) {
  const filesStart = lines.findIndex((line) => line === "files:");
  if (filesStart < 0) throw new Error("Electron update metadata has no files section");
  return filesStart;
}

function collectCurrentFileEntry(lines, entries) {
  let current = [];
  for (const line of lines) {
    const operation = fileEntryLineOperation(line, current.length > 0);
    if (operation.kind === "stop") return current;
    if (operation.kind === "new") {
      if (current.length > 0) entries.push(current.join("\n"));
      current = [line];
    }
    if (operation.kind === "append") current.push(line);
    if (entries.length > MAX_FILE_ENTRIES) {
      throw new Error("Electron update metadata has too many file entries");
    }
  }
  return current;
}

function fileEntryLineOperation(line, hasCurrentEntry) {
  if (line.startsWith("  - url:")) return { kind: "new" };
  if (/^    \S/.test(line) && hasCurrentEntry) return { kind: "append" };
  if (/^\S/.test(line) && line.trim()) return { kind: "stop" };
  return hasCurrentEntry ? { kind: "append" } : { kind: "ignore" };
}

function assertFileEntries(entries) {
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
    NodeFS.writeFileSync(outputPath, primary);
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
  NodeFS.writeFileSync(outputPath, lines.join("\n"));
  return { added: additions.length };
}

if (
  process.argv[1] &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1])
) {
  const [primaryPath, secondaryPath, outputPath] = process.argv.slice(2);
  if (!primaryPath || !secondaryPath || !outputPath) {
    throw new Error(
      "Usage: merge-electron-update-metadata.mjs <primary> <secondary> <output>",
    );
  }
  mergeElectronUpdateMetadata(primaryPath, secondaryPath, outputPath);
}
