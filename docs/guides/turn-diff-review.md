# Last turn changes

Review's **Last turn** view uses the provider's complete patch when it is available and valid. **Agent changes** identifies this source. **Live** means the turn is still running. The settled patch belongs to the assistant message and remains available after reopening the thread.

Source selection uses a valid provider unified patch first, then native full before-and-after evidence such as Cursor ACP. If native evidence is unavailable or rejected, complete tracked file-tool evidence supplies **Tracked file evidence**. Otherwise, Review uses attributed Git snapshots. **Git fallback: same-file edits may appear** explains that another editor's changes to the same file can appear in that comparison. All providers use the same Last turn controls. Cumulative and other Git comparisons keep their existing behavior.

The native text patch limit is 2,097,152 UTF-8 bytes, 20,000 parsed lines, and 32,768 bytes per line. The server validates the complete patch before accepting it. It rejects incomplete hunks, unsafe paths, unsupported quoted paths, binary patches, and over-limit evidence. It does not truncate patches. Repeated Cursor edits must connect the previous after state to the next before state. Rejected evidence uses the next valid source.

Live patches stay in memory. A completed turn stores its selected source separately from the Git snapshot. Stop, failure, replacement, and invalidation clear Live evidence without replacing the previous settled comparison. A reconnected client reads settled evidence until it receives a fresh diff update. Other connected clients retain their Live view. Existing messages and completed Git snapshots remain readable after the database upgrade.

Rename-with-content patches emitted with changed file headers are supported. Git-style rename or copy metadata without this native text form uses Git fallback, with its stated same-file fidelity limit.
