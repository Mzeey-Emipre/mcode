# Settings Reference

Per-setting reference for Mcode's `settings.json`. For schema conventions and structure rules, see [settings-schema.md](../guides/settings-schema.md).

**Location:** `~/.mcode/settings.json`

## All Settings

| Setting | Type | Default | Range | Env Override | Description |
|---------|------|---------|-------|-------------|-------------|
| `appearance.theme` | enum | `"system"` | `"system"` \| `"dark"` \| `"light"` | - | Color theme preference |
| `agent.maxConcurrent` | integer | `5` | > 0 | - | Maximum concurrent agent sessions |
| `agent.defaults.mode` | enum | `"chat"` | `"plan"` \| `"chat"` \| `"agent"` | - | Default interaction mode for new agents |
| `agent.defaults.permission` | enum | `"full"` | `"full"` \| `"supervised"` | - | Default permission mode for new agents |
| `model.defaults.provider` | enum | `"claude"` | `"claude"` \| `"codex"` \| `"gemini"` \| `"copilot"` | - | Default AI provider |
| `model.defaults.id` | string | `"claude-sonnet-4-6"` | - | - | Default model identifier |
| `model.defaults.reasoning` | enum | `"high"` | `"low"` \| `"medium"` \| `"high"` \| `"max"` | - | Default reasoning effort level. `"max"` is only valid for Opus 4.6; it normalizes to `"high"` at runtime on all other models |
| `model.defaults.fallbackId` | string | `"claude-sonnet-4-6"` | - | - | Fallback model when the primary is unavailable. Set to `""` to disable fallback. |
| `terminal.scrollback` | integer | `500` | >= 0 | - | Number of scrollback lines to retain |
| `notifications.enabled` | boolean | `true` | - | - | Whether desktop notifications are enabled |
| `worktree.naming.mode` | enum | `"auto"` | `"auto"` \| `"custom"` \| `"ai"` | - | Naming strategy for new worktree branches |
| `worktree.naming.aiConfirmation` | boolean | `true` | - | - | Prompt before using AI-generated branch names |
| `server.memory.heapMb` | integer | `512` | 64-8192 | `MCODE_SERVER_HEAP_MB` | V8 max old space for the server process (MB) |
