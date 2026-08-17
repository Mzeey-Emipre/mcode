/**
 * ScopedPreGrant — a narrow, one-shot permission bypass the handoff pipeline
 * issues so a freshly forked child can Read its Handoff document on its first
 * Turn without prompting the user, regardless of the Thread's `permissionMode`.
 *
 * The grant is deliberately the smallest authority that makes the Handoff feel
 * invisible (PRD user stories 3 and 4):
 *  - **Path-scoped:** authorises exactly ONE absolute file path. No prefix or
 *    directory matching — a different path is not covered.
 *  - **Turn-scoped:** valid only until the granted Turn ends. {@link clear} is
 *    called when the child's first Turn completes, so the grant never survives
 *    into a second Turn.
 *  - **One-shot:** the first matching consume marks it used; a second Read of
 *    the same path on the same Turn is NOT pre-granted (falls back to the
 *    normal permission flow).
 *
 * This is a pipeline guarantee, not a user-configurable Hook, and it bypasses
 * `permissionMode` only for the single granted Read.
 */
import { resolve } from "node:path";
import { injectable } from "tsyringe";

interface ScopedGrant {
  /** Tool the grant authorises (always "Read" today). */
  toolName: string;
  /** The single absolute path authorised, resolved for stable comparison. */
  resolvedPath: string;
  /** One-shot latch: set on first successful consume. */
  used: boolean;
}

/** Normalise a path so grant issuance and consumption compare equal. */
function normalizePath(p: string): string {
  // resolve() collapses separators and `.`/`..`; lower-case the drive/letters
  // on Windows where the filesystem is case-insensitive.
  const resolved = resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

@injectable()
export class ScopedPreGrantService {
  /** threadId -> active grants for that thread's current granted Turn. */
  private readonly grantsByThread = new Map<string, ScopedGrant[]>();

  /**
   * Authorise a one-shot Read of `path` on `threadId`'s next Turn. Call
   * {@link clear} when that Turn ends to enforce Turn-scoping.
   */
  issue(args: { threadId: string; toolName: string; path: string }): void {
    const list = this.grantsByThread.get(args.threadId) ?? [];
    list.push({ toolName: args.toolName, resolvedPath: normalizePath(args.path), used: false });
    this.grantsByThread.set(args.threadId, list);
  }

  /**
   * Try to consume a grant for a tool call. Returns true (and latches the grant
   * used) only when an UNUSED grant for this thread matches the tool name and
   * the exact resolved path. Path-scoped, one-shot.
   */
  tryConsume(args: { threadId: string; toolName: string; path: string }): boolean {
    const list = this.grantsByThread.get(args.threadId);
    if (!list || list.length === 0) return false;
    const target = normalizePath(args.path);
    const grant = list.find(
      (g) => !g.used && g.toolName === args.toolName && g.resolvedPath === target,
    );
    if (!grant) return false;
    grant.used = true; // one-shot
    return true;
  }

  /** Turn-scoped cleanup: drop every grant for a thread when its granted Turn ends. */
  clear(threadId: string): void {
    this.grantsByThread.delete(threadId);
  }

  /** Whether a thread currently has any unused grant (diagnostics/tests). */
  hasActiveGrant(threadId: string): boolean {
    return (this.grantsByThread.get(threadId) ?? []).some((g) => !g.used);
  }
}
