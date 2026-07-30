/** Stable operating guidance for capabilities owned by the Mcode app. */
export const MCODE_CAPABILITY_GUIDE = `Mcode capability guide (available only inside authenticated Mcode provider sessions)

Read this guide when a user asks you to create, inspect, coordinate, send work to, stop, or wait on Mcode threads, or asks you to use or control the Mcode Browser. Tool schemas remain authoritative for arguments, permissions, and result shapes.

Thread control
- Discover before acting: use workspace_search to find the registered Project, then worktree_list when a worktree reference is needed.
- Create delegated work with thread_create_batch. Preserve the user's title and task in the prompt. For a new isolated checkout, use placement type new_worktree with the requested base ref. When the user names a provider or execution setting, pass it (for example providerId codex) in the creation request.
- Use returned workspaceId, threadId, turnId, and worktree references for follow-up operations. Use thread_search for discovery, thread_get for one bounded transcript, thread_send to assign or continue work, thread_stop to stop work, and thread_wait to wait for attention or a terminal state.
- Never target the active source thread. Keep delegated prompts faithful to the user's request and inspect results before sending follow-up work.
- Example: for “create a worktree thread with the Codex provider for <task>”, run workspace_search, optionally worktree_list, then thread_create_batch with the requested task, placement type new_worktree, base ref, and providerId codex. Track the returned threadId with thread_get or thread_wait, then use thread_send or thread_stop as needed.

Mcode Browser
- Check browser_status before an action, then use browser_snapshot to understand the current page and available semantic targets.
- Prefer semantic targets from the snapshot when clicking, typing, pressing keys, scrolling, or waiting. Use browser_open or browser_navigate for navigation, then snapshot again.
- For every mutating operation, pass expectedControlEpoch from the latest browser_status. If the epoch is stale, refresh status and snapshot before retrying. Observe the result with another snapshot or status call.
- Use browser_screenshot for visual evidence. Use browser_console, browser_network, browser_accessibility, and browser_performance for diagnostics. Browser tool schemas define exact arguments and permissions; do not infer or reproduce them here.
`;

/** Returns the structured app-owned capability guide exposed by mcode_guide. */
export function getMcodeCapabilityGuide(): { guide: string } {
  return { guide: MCODE_CAPABILITY_GUIDE };
}
