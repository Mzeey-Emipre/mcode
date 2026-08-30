/** Maximum text retained from one browser diagnostic field. */
export const BROWSER_DIAGNOSTIC_TEXT_LIMIT = 4_096;

const SECRET_KEY = /^(?:access[_-]?token|api[_-]?key|auth|authorization|bearer|code|cookie|credential|jwt|password|refresh[_-]?token|secret|session|session[_-]?id|token)$/i;
const SECRET_TEXT = /\b(?:access[_-]?token|api[_-]?key|authorization|bearer|cookie|credential|password|refresh[_-]?token|secret|session[_-]?id|token)\b\s*[:=]\s*([^\s,;]+)/gi;
const BEARER_TEXT = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT_TEXT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** Redacts credential-shaped text before it crosses into provider-visible diagnostics. */
export function redactBrowserText(value: unknown, limit = BROWSER_DIAGNOSTIC_TEXT_LIMIT): string {
  return String(value ?? "")
    .replace(BEARER_TEXT, "Bearer [REDACTED]")
    .replace(JWT_TEXT, "[REDACTED]")
    .replace(SECRET_TEXT, (match, captured: string) => match.replace(captured, "[REDACTED]"))
    .slice(0, Math.max(0, limit));
}

/** Removes secret query values and URL credentials while retaining a useful request identity. */
export function redactBrowserUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value).slice(0, 8_192));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys()) {
      if (SECRET_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    if (url.hash.length > 1) {
      const fragment = new URLSearchParams(url.hash.slice(1));
      let changed = false;
      for (const key of fragment.keys()) {
        if (!SECRET_KEY.test(key)) continue;
        fragment.set(key, "[REDACTED]");
        changed = true;
      }
      if (changed) url.hash = fragment.toString();
    }
    return url.toString().slice(0, 2_048);
  } catch {
    return null;
  }
}

/** Sanitizes the current page location without leaking opaque URL payloads. */
export function redactBrowserLocation(value: unknown): string {
  const raw = String(value ?? "").slice(0, 8_192);
  const http = redactBrowserUrl(raw);
  if (http) return http;
  if (raw === "about:blank") return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "blob:") {
      const inner = redactBrowserUrl(raw.slice("blob:".length));
      return inner ? `blob:${new URL(inner).origin}/[REDACTED]` : "blob:[REDACTED]";
    }
    return `${parsed.protocol}[REDACTED]`;
  } catch {
    return "about:blank";
  }
}

/** Removes all query and fragment data from provider-visible diagnostic URLs. */
export function redactBrowserDiagnosticUrl(value: unknown): string | null {
  const redacted = redactBrowserUrl(value);
  if (!redacted) return null;
  const url = new URL(redacted);
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Redacts provider-visible values recursively without retaining cookies, headers, or storage. */
export function redactBrowserValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactBrowserText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return redactBrowserArray(value, depth);
  if (typeof value !== "object") return null;
  return redactBrowserObject(value as Record<string, unknown>, depth);
}

/** Redacts a bounded array before it crosses into provider-visible diagnostics. */
function redactBrowserArray(value: unknown[], depth: number): unknown[] {
  return value.slice(0, 200).map((item) => redactBrowserValue(item, depth + 1));
}

/** Redacts bounded object properties before they cross into provider-visible diagnostics. */
function redactBrowserObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  let retained = 0;
  for (const key in value) {
    if (retained >= 200) break;
    const item = value[key];
    output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactBrowserValue(item, depth + 1);
    retained += 1;
  }
  return output;
}
