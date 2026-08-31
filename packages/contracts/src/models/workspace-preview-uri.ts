/**
 * Virtual URL scheme for workspace-relative preview targets. Electron resolves these
 * with the active workspace root before loading `file:` URLs in a Browser surface.
 */
export const MCODE_WORKSPACE_PREVIEW_PROTOCOL = "mcode-workspace:";

/** File extensions surfaced as Markdown preview shortcuts (links and inline code). */
const WORKSPACE_MARKDOWN_PREVIEW_EXT_RE = /\.(html?|svg)$/i;

/**
 * Returns true when `url` uses the mcode-workspace preview scheme.
 */
export function isMcodeWorkspacePreviewUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith(MCODE_WORKSPACE_PREVIEW_PROTOCOL);
}

/**
 * Builds an `mcode-workspace:` URL for a path relative to the workspace root. Slashes may be `/` or `\\`.
 */
export function mcodeWorkspacePreviewHref(relativePosixPath: string): string {
  const rel = markdownWorkspaceRefToPreviewPath(relativePosixPath);
  if (!rel) return `${MCODE_WORKSPACE_PREVIEW_PROTOCOL}///`;
  const segments = rel.split("/").map((seg) => encodeURIComponent(seg));
  return `${MCODE_WORKSPACE_PREVIEW_PROTOCOL}///${segments.join("/")}`;
}

/**
 * Strips leading `./`, `../` segments are kept; removes leading slashes so resolution stays workspace-relative.
 */
export function markdownWorkspaceRefToPreviewPath(href: string): string {
  let h = href.trim().replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(h) || h.startsWith("~")) return "";
  while (h.startsWith("/")) h = h.slice(1);
  if (h.startsWith("./")) h = h.slice(2);
  return h;
}

/**
 * True when `text` looks like a workspace-relative previewable path in Markdown (inline code or link `href`).
 */
export function looksLikeWorkspaceRelativeFileRef(text: string): boolean {
  const t = text.trim();
  if (isAbsoluteOrRemoteReference(t)) return false;
  if (!WORKSPACE_MARKDOWN_PREVIEW_EXT_RE.test(t)) return false;
  if (isExplicitWorkspaceReference(t)) return true;
  const firstSeg = t.split(/[/\\]/)[0] ?? "";
  const looksDomainLike = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(firstSeg);
  if (hasPathSeparator(t)) return !looksDomainLike;
  if (!firstSeg.includes(".")) return false;
  return WORKSPACE_MARKDOWN_PREVIEW_EXT_RE.test(firstSeg);
}

function isAbsoluteOrRemoteReference(value: string): boolean {
  return !value || value.includes("://") || /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("~");
}

function isExplicitWorkspaceReference(value: string): boolean {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../");
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}
