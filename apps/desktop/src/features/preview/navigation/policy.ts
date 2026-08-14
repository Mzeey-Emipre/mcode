/**
 * Pure URL policy shared by Preview target resolution and local-file validation.
 */

/** Returns true when the URL uses the HTTP or HTTPS protocol. */
export function isAllowedHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Returns true when the URL uses an allowed Preview protocol. */
export function isAllowedPreviewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:";
  } catch {
    return false;
  }
}
