/**
 * Centralized auth token extraction for HTTP and WebSocket requests.
 *
 * Shared by `ws-server.ts` connection handling and the `POST /shutdown` endpoint
 * so token validation logic lives in one place.
 */

import type { IncomingMessage } from "http";

/** Minimal request shape required for token extraction. */
type RequestLike = Pick<IncomingMessage, "url" | "headers">;

/**
 * Extract an auth token from a request using the following precedence:
 * 1. `?token=` query parameter
 * 2. `Authorization: Bearer <token>` header
 * 3. `mcode-auth` cookie
 *
 * Returns `null` when no token is present in any of the three locations.
 */
export function extractToken(req: RequestLike): string | null {
  // 1. Authorization header (cheapest check, no object allocation)
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // 2. Query param (only parse URL when header was absent)
  if (req.url) {
    const qIdx = req.url.indexOf("?token=");
    if (qIdx !== -1) {
      const start = qIdx + 7;
      const end = req.url.indexOf("&", start);
      return end === -1 ? req.url.slice(start) : req.url.slice(start, end);
    }
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
