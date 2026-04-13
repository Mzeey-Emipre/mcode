/**
 * Centralized auth token extraction for HTTP and WebSocket requests.
 *
 * Shared by `ws-server.ts` connection handling and the `POST /shutdown` endpoint
 * so token validation logic lives in one place.
 */

import { URL } from "url";

/** Minimal request shape required for token extraction. */
interface RequestLike {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Extract an auth token from a request using the following precedence:
 * 1. `?token=` query parameter
 * 2. `Authorization: Bearer <token>` header
 * 3. `mcode-auth` cookie
 *
 * Returns `null` when no token is present in any of the three locations.
 */
export function extractToken(req: RequestLike): string | null {
  // 1. Query param
  if (req.url) {
    try {
      const parsed = new URL(req.url, "http://localhost");
      const fromQuery = parsed.searchParams.get("token");
      if (fromQuery) return fromQuery;
    } catch {
      // Malformed URL - skip query param extraction
    }
  }

  // 2. Authorization header
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // 3. Cookie
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader === "string") {
    const match = cookieHeader.match(/(?:^|;\s*)mcode-auth=([^;]+)/);
    if (match) return match[1];
  }

  return null;
}

/**
 * Build a `Set-Cookie` header value that stores the mcode auth token.
 *
 * Cookie attributes: HttpOnly, SameSite=Strict, Path=/, 1-year max age.
 */
export function buildAuthCookie(token: string): string {
  return `mcode-auth=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
}
