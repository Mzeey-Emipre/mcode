/**
 * Local file preview support: path resolution, security guards, and validation
 * for serving `file:` URLs in the embedded BrowserSurfaceHost page.
 */

import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { isMcodeWorkspacePreviewUrl } from "@mcode/contracts";

import { type PreviewSession } from "../state/window-session.js";
import { isAllowedPreviewUrl } from "./policy.js";

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
  const segments = NodePath.normalize(filePath).split(NodePath.sep);
  return segments.some((seg) =>
    SENSITIVE_FILE_PATTERNS.some((pat) => pat.test(seg)),
  );
}

/**
 * Detects Windows UNC paths so SMB targets never reach `lstat` / `realpath`.
 * Keeps `\\?\` and `\\.\` prefixes (local extended/device paths) allowed.
 */
export function isUncPath(filePath: string): boolean {
  const n = NodePath.normalize(filePath);
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
  const pathname = workspacePreviewPathname(trimmed);
  if (pathname === null) return { ok: false, error: "invalid-url" };
  const raw = pathname.replace(/^\/+/, "");
  if (!raw) return { ok: false, error: "empty-url" };
  const rel = decodeWorkspacePreviewPath(raw);
  if (rel === null || !isSafeWorkspaceRelativePath(rel)) return { ok: false, error: "invalid-url" };
  return resolveLocalFileUrl(rel, workspacePath);
}

function workspacePreviewPathname(input: string): string | null {
  try {
    return new URL(input).pathname;
  } catch {
    return null;
  }
}

function decodeWorkspacePreviewPath(raw: string): string | null {
  const decodedSegments: string[] = [];
  for (const segment of raw.split("/")) {
    const decoded = decodeWorkspacePreviewSegment(segment);
    if (decoded === null) return null;
    decodedSegments.push(decoded);
  }
  return decodedSegments.join("/");
}

function decodeWorkspacePreviewSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    if (decoded.includes("\0") || decoded.split(/[/\\]/).includes("..")) return null;
    return decoded.replace(/\\/g, "/");
  } catch {
    return null;
  }
}

function isSafeWorkspaceRelativePath(relativePath: string): boolean {
  const normalized = NodePath.normalize(relativePath);
  if (NodePath.isAbsolute(normalized) || normalized === "..") return false;
  return !normalized.startsWith(`..${NodePath.sep}`) && !normalized.startsWith("../") && !normalized.startsWith("..\\");
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
  const resolved = resolvePreviewFilePath(trimmed, workspacePath);
  if (!resolved.ok) return resolved;
  if (isUncPath(resolved.path) || isSensitivePath(resolved.path)) {
    return { ok: false, error: "sensitive-file" };
  }
  return verifyPreviewFilePath(resolved.path);
}

function resolvePreviewFilePath(
  input: string,
  workspacePath: string | null,
): { ok: true; path: string } | { ok: false; error: string } {
  if (input.startsWith("\\\\")) return { ok: false, error: "sensitive-file" };
  if (/^file:\/\//i.test(input)) return resolveFileUrlPath(input);
  if (input.startsWith("~")) return { ok: true, path: resolveHomePath(input) };
  if (NodePath.isAbsolute(input)) return { ok: true, path: NodePath.normalize(NodePath.resolve(input)) };
  if (!workspacePath) return { ok: false, error: "no-workspace" };
  return { ok: true, path: NodePath.normalize(NodePath.resolve(workspacePath, input)) };
}

function resolveFileUrlPath(input: string): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const url = new URL(input);
    if (url.protocol !== "file:") return { ok: false, error: "invalid-url" };
    if (!isLocalFileHost(url.hostname)) return { ok: false, error: "sensitive-file" };
    return { ok: true, path: NodePath.normalize(NodeURL.fileURLToPath(input)) };
  } catch {
    return { ok: false, error: "invalid-url" };
  }
}

function isLocalFileHost(hostname: string): boolean {
  return hostname === "" || hostname.toLowerCase() === "localhost";
}

function resolveHomePath(input: string): string {
  const offset = input.startsWith("~/") || input.startsWith("~\\") ? 2 : 1;
  return NodePath.normalize(NodePath.resolve(NodeOS.homedir(), input.slice(offset)));
}

async function verifyPreviewFilePath(
  unresolvedPath: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const resolved = await resolveSymbolicPreviewFilePath(unresolvedPath);
    if (!resolved.ok) return resolved;
    if (resolved.info.isDirectory()) return resolveDirectoryPreviewUrl(resolved.path);
    if (!resolved.info.isFile()) return { ok: false, error: "not-a-file" };
    return { ok: true, url: NodeURL.pathToFileURL(resolved.path).href };
  } catch {
    return { ok: false, error: "file-not-found" };
  }
}

async function resolveSymbolicPreviewFilePath(unresolvedPath: string): Promise<
  | { ok: true; path: string; info: Awaited<ReturnType<typeof NodeFSPromises.lstat>> }
  | { ok: false; error: "sensitive-file" }
> {
  const info = await NodeFSPromises.lstat(unresolvedPath);
  if (!info.isSymbolicLink()) return { ok: true, path: unresolvedPath, info };
  const path = await NodeFSPromises.realpath(unresolvedPath);
  if (isSensitivePath(path)) return { ok: false, error: "sensitive-file" };
  return { ok: true, path, info: await NodeFSPromises.lstat(path) };
}

async function resolveDirectoryPreviewUrl(
  directoryPath: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const indexPath = NodePath.join(directoryPath, "index.html");
    if (!(await NodeFSPromises.stat(indexPath)).isFile()) return { ok: false, error: "is-directory" };
    return { ok: true, url: NodeURL.pathToFileURL(indexPath).href };
  } catch {
    return { ok: false, error: "is-directory" };
  }
}

/**
 * Heuristic: returns true when the input looks like a local file path rather
 * than a domain name. Matches tilde prefix, drive letters (C:\), explicit
 * slashes (./, ../, /), and common file extensions (.html, .pdf, etc.).
 */
export function looksLikeFilePath(input: string): boolean {
  if (hasFilePathPrefix(input)) return true;
  if (/^[A-Za-z]:[/\\]/.test(input)) return true;
  const firstSlash = input.indexOf("/");
  const firstSegment = firstSlash >= 0 ? input.slice(0, firstSlash) : input;
  if (firstSegment.includes(".") && !firstSegment.includes("\\")) return false;
  const hasPathSep = input.includes("/") || input.includes("\\");
  return hasPathSep && BROWSER_VIEWABLE_EXT_RE.test(input);
}

function hasFilePathPrefix(input: string): boolean {
  return input.startsWith("~") || input.startsWith("/") || input.startsWith("./") || input.startsWith("../") || input.startsWith(".\\") || input.startsWith("..\\");
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
      const filePath = NodeURL.fileURLToPath(url);
      const result = await resolveLocalFileUrl(filePath, null);
      return result.ok ? result.url : null;
    }
  } catch {
    return null;
  }
  return url;
}
