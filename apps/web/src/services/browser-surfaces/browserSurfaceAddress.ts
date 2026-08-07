import { BROWSER_TAB_INFO_STRING_MAX } from "@mcode/contracts";

/** Validates and normalizes an absolute HTTP(S) Browser surface address. */
export function normalizeBrowserSurfaceAddress(address: string): string {
  if (address.length > BROWSER_TAB_INFO_STRING_MAX.url) {
    throw new TypeError("Browser surface address exceeds the maximum length");
  }
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new TypeError("Browser surface address must be an absolute URL");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new TypeError("Browser surface address must use HTTP(S) without credentials");
  }
  return parsed.href;
}
