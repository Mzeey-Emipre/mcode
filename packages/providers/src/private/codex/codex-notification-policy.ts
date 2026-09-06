/** A content-free receipt for the actual handling of one native notification. */
export type CodexNotificationDisposition =
  | { kind: "mapped" }
  | { kind: "state-only"; reason: "native-state" | "buffered-child" }
  | { kind: "diagnostic"; reason: "unknown-notification" | "malformed-notification" | "unattributed-thread" }
  | { kind: "ignored-with-reason"; reason: string };

/** Exact native methods intentionally omitted from Mcode's current product surfaces. */
export const CODEX_IGNORED_NOTIFICATIONS: Readonly<Record<string, string>> = {
  "turn/diff/updated": "native-diff-slice-deferred",
  "skills/changed": "skills-refresh-not-subscribed",
  "item/fileChange/outputDelta": "file-change-completion-is-authoritative",
  "item/reasoning/summaryPartAdded": "reasoning-text-deltas-are-authoritative",
  "item/mcpToolCall/progress": "tool-completion-is-authoritative",
  "remoteControl/status/changed": "remote-control-not-used",
  "thread/status/changed": "turn-lifecycle-is-authoritative",
  "thread/tokenUsage/updated": "turn-completion-usage-is-authoritative",
  "thread/archived": "archive-rpc-is-authoritative",
  "thread/unarchived": "archive-rpc-is-authoritative",
  "thread/closed": "session-runtime-owns-closure",
  "thread/name/updated": "mcode-owns-thread-titles",
  "hook/started": "native-hooks-not-projected",
  "hook/completed": "native-hooks-not-projected",
  "rawResponseItem/completed": "typed-items-are-authoritative",
  "rawResponse/completed": "typed-items-are-authoritative",
  "serverRequest/resolved": "permission-response-is-authoritative",
  "mcpServer/oauthLogin/completed": "mcode-owns-mcp-authentication",
  "account/login/completed": "mcode-owns-authentication",
  "fuzzyFileSearch/sessionUpdated": "native-file-search-not-used",
  "fuzzyFileSearch/sessionCompleted": "native-file-search-not-used",
  "windowsSandbox/setupCompleted": "sandbox-setup-rpc-is-authoritative",
  "app/list/updated": "native-app-catalog-not-used",
  "fs/changed": "native-file-watches-not-subscribed",
};

/** Returns a stable ignore reason only for an explicitly recognized native method. */
export function codexIgnoredNotificationReason(method: string): string | undefined {
  return Object.hasOwn(CODEX_IGNORED_NOTIFICATIONS, method) ? CODEX_IGNORED_NOTIFICATIONS[method] : undefined;
}
