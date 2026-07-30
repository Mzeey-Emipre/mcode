/** Stable operating guidance for the Mcode Browser capability. */
export const MCODE_BROWSER_GUIDE = `Mcode Browser guide (available only inside authenticated Mcode provider sessions)

- Check browser_status before an action, then use browser_snapshot to understand the current page and available semantic targets.
- Prefer semantic targets from the snapshot when clicking, typing, pressing keys, scrolling, or waiting. Use browser_open or browser_navigate for navigation, then snapshot again.
- For every mutating operation, pass expectedControlEpoch from the latest browser_status. If the epoch is stale, refresh status and snapshot before retrying. Observe the result with another snapshot or status call.
- Use browser_screenshot for visual evidence. Use browser_console, browser_network, browser_accessibility, and browser_performance for diagnostics. Browser tool schemas define exact arguments and permissions; do not infer or reproduce them here.
`;

/** Stable operating guidance for Mcode thread and worktree control. */
export const THREAD_CONTROL_GUIDE = `Mcode thread-control guide (available only inside authenticated Mcode provider sessions)

- Resolve an explicitly named Project with workspace_search; use worktree_list only when resolving an explicit worktree or reference. For default delegated work, use the active source thread's Project without discovery.
- Create delegated work with thread_create_batch. Preserve the user's title and task in the prompt. If a new thread is requested without an explicit Project, create it in the active source thread's Project; do not ask for or select another Project. When a new worktree thread is requested without an explicit branch, use placement type new_worktree with the appropriate baseRef and omit branchName. Set branchName only when the user explicitly names a branch. Resolve an explicitly named Project and respect an explicitly requested worktree. When the user names a provider or execution setting, pass it (for example providerId codex) in the creation request.
- Use returned workspaceId, threadId, turnId, and worktree references for follow-up operations. Use thread_search for discovery, thread_get for one bounded transcript, thread_send to assign or continue work, thread_stop to stop work, and thread_wait to wait for attention or a terminal state.
- Never target the active source thread. Keep delegated prompts faithful to the user's request and inspect results before sending follow-up work.
- Example: for “create a worktree thread with the Codex provider for <task>”, run thread_create_batch directly in the active source thread's Project with placement type new_worktree, the appropriate baseRef, no branchName, and providerId codex. Track the returned threadId with thread_get or thread_wait, then use thread_send or thread_stop as needed.
`;

/** Returns the structured app-owned Browser operating guide. */
export function getMcodeBrowserGuide(): { guide: string } {
  return { guide: MCODE_BROWSER_GUIDE };
}

/** Returns the structured app-owned thread-control operating guide. */
export function getThreadControlGuide(): { guide: string } {
  return { guide: THREAD_CONTROL_GUIDE };
}
