/**
 * Pure omnibox target normalization and validation for Preview navigation.
 */

import { isMcodeWorkspacePreviewUrl } from "@mcode/contracts";

import {
  looksLikeFilePath,
  resolveLocalFileUrl,
  resolveMcodeWorkspacePreviewUrl,
} from "./local-file.js";
import { isAllowedPreviewUrl } from "./policy.js";

/** Result returned after normalizing and validating an omnibox target. */
export type PreviewResolveNavigationResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Returns true when `input` looks like a bare host rather than a free-form search query.
 */
export function looksLikeBareDomain(input: string): boolean {
  if (/\s/.test(input)) return false;
  const hostPart = input.split("/", 1)[0]!;
  if (hostPart.length === 0) return false;
  if (!/^[a-z0-9.\-:]+$/i.test(hostPart)) return false;
  if (hostPart === "localhost" || /^localhost:\d+$/.test(hostPart)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(hostPart)) return true;
  if (!hostPart.includes(".")) return false;
  const tld = hostPart.split(":")[0]!.split(".").pop() ?? "";
  return /^[a-z][a-z0-9-]{1,}$/i.test(tld);
}

/** Resolve user omnibox input to a safe Preview URL without loading it. */
export async function resolvePreviewNavigationTarget(
  url: string,
  workspacePath?: string | null,
): Promise<PreviewResolveNavigationResult> {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, error: "empty-url" };

  let target: string;

  if (isMcodeWorkspacePreviewUrl(trimmed)) {
    const resolved = await resolveMcodeWorkspacePreviewUrl(
      trimmed,
      workspacePath?.trim() ?? null,
    );
    if (!resolved.ok) return resolved;
    target = resolved.url;
  } else if (/^https?:\/\//i.test(trimmed)) {
    target = trimmed;
  } else if (/^file:\/\//i.test(trimmed)) {
    const resolved = await resolveLocalFileUrl(trimmed, workspacePath?.trim() ?? null);
    if (!resolved.ok) return resolved;
    target = resolved.url;
  } else if (looksLikeFilePath(trimmed)) {
    const resolved = await resolveLocalFileUrl(trimmed, workspacePath?.trim() ?? null);
    if (!resolved.ok) return resolved;
    target = resolved.url;
  } else if (looksLikeBareDomain(trimmed)) {
    target = `https://${trimmed}`;
  } else {
    target = `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  }

  if (!isAllowedPreviewUrl(target)) return { ok: false, error: "invalid-url" };
  return { ok: true, url: target };
}
