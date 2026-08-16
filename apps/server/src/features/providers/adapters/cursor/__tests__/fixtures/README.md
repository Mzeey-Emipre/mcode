# Cursor ACP capture fixtures

Golden traces from live `agent acp` capture (`bun apps/server/scripts/capture-cursor-acp.ts --suite`, 2026-05-20).

| File | Contents |
|------|----------|
| `cursor-acp-suite-raw.jsonl` | Sanitized ACP lines: `tool_call`, `tool_call_update`, `cursor/task` ext |
| `cursor-acp-suite-mapped.jsonl` | Same events after Mcode mapper + `cursor-acp-task` |

Full logs (including text chunks) stay under `<repo>/.mcode-local/cursor-acp-capture/` (gitignored).

## Subagents and grouping

**Captured in the parent session:**

1. `tool_call` with `rawInput._toolName: "task"`, `title: "Task: Subagent task"`
2. `tool_call_update` `completed` (often before metadata)
3. `cursor/task` ext with `toolCallId`, `description`, `prompt`, `model`, `agentId`, `subagentType`

Mapper emits top-level `toolName: "Agent"` rows keyed by `toolCallId`. Use that id as the parent for narrative nesting when Cursor adds `parentToolCallId` on child tools.

**Not in the parent session (capture gap):**

- No `parentToolCallId` (or alias) on any envelope
- Read/Glob/Edit tools run inside the subagent do not stream on the parent ACP session

So Mcode can render parallel **Agent** delegation cards (with `agentId` in `toolInput`), but cannot yet group child tool calls under each subagent from ACP alone. `agent-service` stack fallback only applies when non-Agent tools arrive on the same thread with a running Agent on the stack.

## Mapper enrichment (post-capture)

- **Read:** `file_path` from `rawOutput.path` (or title when it looks like a path).
- **Grep:** `pattern` / `path` from `rawInput` or `rawOutput`; falls back to `"N matches"` from `totalMatches`.
- **Bash:** `command` from `rawInput` on `kind: execute` tool calls.
- **Write:** `kind: write` uses the same diff/content paths as Edit when Cursor sends them.

Regenerate fixtures: `bun apps/server/scripts/capture-cursor-acp.ts --suite`, then copy tool lines into `cursor-acp-suite-*.jsonl` or re-run the extract helper in the capture script.
