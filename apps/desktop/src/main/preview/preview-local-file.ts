/**
 * Local file preview support: path resolution, security guards, and validation
 * for serving `file:` URLs in the embedded BrowserSurfaceHost page.
 */

import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isMcodeWorkspacePreviewUrl } from "@mcode/contracts";

import { type PreviewSession, isAllowedPreviewUrl } from "./preview-session.js";

/** Pre-compiled regex for browser-viewable file extensions (hoisted to avoid recompilation per navigate). */
export const BROWSER_VIEWABLE_EXT_RE =
  /\.(html?|pdf|svg|xml|xhtml|mhtml|txt|json|css|js|mjs|webp|png|jpe?g|gif|bmp|ico|avif)$/i;

/** Basename patterns that should never be served in the preview. */
export const SENSITIVE_FILE_PATTERNS = [
  /^\.env/i,
  /^\.git$/i,
  /^\.ssh$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^\.aws$/i,
  /^credentials/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
];

/**
 * Returns true when any segment of a normalized path matches a sensitive
 * file or directory pattern (e.g. `.env`, `.git/config`, `.ssh/id_rsa`).
 */
export function isSensitivePath(filePath: string): boolean {
  const segments = normalize(filePath).split(sep);
  return segments.some((seg) =>
    SENSITIVE_FILE_PATTERNS.some((pat) => pat.test(seg)),
  );
}

/**
 * Detects Windows UNC paths so SMB targets never reach `lstat` / `realpath`.
 * Keeps `\\?\` and `\\.\` prefixes (local extended/device paths) allowed.
 */
export function isUncPath(filePath: string): boolean {
  const n = normalize(filePath);
  if (!n.startsWith("\\\\")) return false;
  if (n.startsWith("\\\\?\\") || n.startsWith("\\\\.\\")) return false;
  return true;
}

/** Marks the next main-process `file:` navigation as trusted for the will-navigate gate. */
export function trustMainProcessFileNavigation(s: PreviewSession, url: string): void {
  try {
    if (new URL(url).protocol === "file:") {
      s.trustedFileNavigationBudget++;
    }
  } catch {
    /* malformed URLs do not consume budget */
  }
}

/**
 * Resolves an `mcode-workspace:` navigation string to a local `file:` URL using
 * the active workspace root (same rules as relative paths in {@link resolveLocalFileUrl}).
 */
export async function resolveMcodeWorkspacePreviewUrl(
  input: string,
  workspacePath: string | null,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const trimmed = input.trim();
  if (!isMcodeWorkspacePreviewUrl(trimmed)) {
    return { ok: false, error: "invalid-url" };
  }
  let pathname: string;
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    return { ok: false, error: "invalid-url" };
  }
  const raw = pathname.replace(/^\/+/, "");
  if (!raw) return { ok: false, error: "empty-url" };
  const decodedSegments: string[] = [];
  for (const urlSeg of raw.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlSeg);
    } catch {
      return { ok: false, error: "invalid-url" };
    }
    if (decoded.includes("\0")) {
      return { ok: false, error: "invalid-url" };
    }
    for (const piece of decoded.split(/[/\\]/)) {
      if (piece === "..") {
        return { ok: false, error: "invalid-url" };
      }
    }
    decodedSegments.push(decoded.replace(/\\/g, "/"));
  }
  const rel = decodedSegments.join("/");
  const normalizedRel = normalize(rel);
  if (
    isAbsolute(normalizedRel) ||
    normalizedRel === ".." ||
    normalizedRel.startsWith(`..${sep}`) ||
    normalizedRel.startsWith("../") ||
    normalizedRel.startsWith("..\\")
  ) {
    return { ok: false, error: "invalid-url" };
  }
  return resolveLocalFileUrl(rel, workspacePath);
}

/**
 * Resolve user input into a `file://` URL.
 *
 * Handles tilde expansion (`~/...`), absolute paths, paths relative to
 * `workspacePath`, and raw `file://` inputs (rejecting non-local hosts).
 * Returns an error result when the path is not previewable, blocked, or missing.
 */
export async function resolveLocalFileUrl(
  input: string,
  workspacePath: string | null,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const trimmed = input.trim();

  if (trimmed.startsWith("\\\\")) {
    return { ok: false, error: "sensitive-file" };
  }

  let resolved: string;

  if (/^file:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      if (u.protocol !== "file:") {
        return { ok: false, error: "invalid-url" };
      }
      const host = u.hostname.toLowerCase();
      if (host !== "" && host !== "localhost") {
        return { ok: false, error: "sensitive-file" };
      }
      resolved = normalize(fileURLToPath(trimmed));
    } catch {
      return { ok: false, error: "invalid-url" };
    }
  } else if (trimmed.startsWith("~")) {
    resolved = resolve(homedir(), trimmed.slice(trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? 2 : 1));
    resolved = normalize(resolved);
  } else if (isAbsolute(trimmed)) {
    resolved = normalize(resolve(trimmed));
  } else if (workspacePath) {
    resolved = normalize(resolve(workspacePath, trimmed));
  } else {
    return { ok: false, error: "no-workspace" };
  }

  if (isUncPath(resolved)) {
    return { ok: false, error: "sensitive-file" };
  }

  if (isSensitivePath(resolved)) {
    return { ok: false, error: "sensitive-file" };
  }

  try {
    let info = await lstat(resolved);
    if (info.isSymbolicLink()) {
      const real = await realpath(resolved);
      if (isSensitivePath(real)) {
        return { ok: false, error: "sensitive-file" };
      }
      resolved = real;
      info = await lstat(real);
    }
    if (info.isDirectory()) {
      const indexPath = join(resolved, "index.html");
      try {
        const indexInfo = await stat(indexPath);
        if (indexInfo.isFile()) {
          return { ok: true, url: pathToFileURL(indexPath).href };
        }
      } catch {
        return { ok: false, error: "is-directory" };
      }
    }
    if (!info.isFile()) {
      return { ok: false, error: "not-a-file" };
    }
  } catch {
    return { ok: false, error: "file-not-found" };
  }

  return { ok: true, url: pathToFileURL(resolved).href };
}

/**
 * Heuristic: returns true when the input looks like a local file path rather
 * than a domain name. Matches tilde prefix, drive letters (C:\), explicit
 * slashes (./, ../, /), and common file extensions (.html, .pdf, etc.).
 */
export function looksLikeFilePath(input: string): boolean {
  if (input.startsWith("~")) return true;
  if (input.startsWith("/") || input.startsWith("./") || input.startsWith("../")) return true;
  if (input.startsWith(".\\") || input.startsWith("..\\")) return true;
  if (/^[A-Za-z]:[/\\]/.test(input)) return true;
  const firstSlash = input.indexOf("/");
  const firstSegment = firstSlash >= 0 ? input.slice(0, firstSlash) : input;
  if (firstSegment.includes(".") && !firstSegment.includes("\\")) {
    return false;
  }
  const hasPathSep = input.includes("/") || input.includes("\\");
  if (hasPathSep && BROWSER_VIEWABLE_EXT_RE.test(input)) return true;
  return false;
}

/**
 * Validates a resume/hint URL before loading. HTTP(S) URLs pass through;
 * file:// URLs are re-checked through resolveLocalFileUrl to prevent
 * renderer-supplied hints from bypassing sensitive-path guards.
 */
export async function validateResumeUrl(url: string | null): Promise<string | null> {
  if (!url || !isAllowedPreviewUrl(url)) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "file:") {
      const host = u.hostname.toLowerCase();
      if (host !== "" && host !== "localhost") return null;
      const filePath = fileURLToPath(url);
      const result = await resolveLocalFileUrl(filePath, null);
      return result.ok ? result.url : null;
    }
  } catch {
    return null;
  }
  return url;
}
