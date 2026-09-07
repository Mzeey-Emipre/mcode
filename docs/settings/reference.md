# Settings Reference

Per-setting reference for Mcode's `settings.json`. For schema conventions and structure rules, see [settings-schema.md](../guides/settings-schema.md).

**Location:** `~/.mcode/settings.json`

## All Settings

| Setting | Type | Default | Range | Env Override | Description |
|---------|------|---------|-------|-------------|-------------|
| `appearance.theme` | enum | `"system"` | `"system"` \| `"dark"` \| `"light"` | - | Color theme preference |
| `agent.maxConcurrent` | integer | `5` | > 0 | - | Maximum concurrent agent sessions |
| `agent.defaults.mode` | enum | `"build"` | `"plan"` \| `"build"` \| `"agent"` | - | Default interaction mode for new agents |
| `agent.defaults.permission` | enum | `"full"` | `"full"` \| `"supervised"` | - | Default permission mode for new agents |
| `agent.guardrails.maxBudgetUsd` | number | `0` | >= 0 | - | Stop the agent when session cost exceeds this USD amount. `0` disables. Claude only. |
| `agent.guardrails.maxTurns` | integer | `0` | >= 0 | - | Stop the agent after this many turns. `0` disables. Claude only. |
| `model.defaults.provider` | enum | `"claude"` | `"claude"` \| `"codex"` \| `"gemini"` \| `"copilot"` | - | Default AI provider |
| `model.defaults.id` | string | `"claude-opus-4-8"` | - | - | Default model identifier for new installs. Existing users keep their stored value. |
| `model.defaults.reasoning` | enum | `"high"` | `"none"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | - | Default reasoning effort level. Tiers in ascending order: `low < medium < high < xhigh < max`. `"none"` and `"minimal"` map to OpenAI Codex effort presets; Claude models normalize them to `"low"`. `"xhigh"` requires Opus 4.8 or Opus 4.7 for Claude. `"max"` requires Fable 5, Sonnet 5, Opus 4.8, Opus 4.7, Opus 4.6, or Sonnet 4.6; it normalizes to `"high"` at runtime on other Claude models. Stored legacy `"ultra"` and `"ultrathink"` values normalize to `"max"`. Haiku 4.5 ignores this setting because the effort parameter is not sent for that model. Ultra and Ultracode are composer orchestration capabilities, not reasoning settings. |
| `model.defaults.fallbackId` | string | `"claude-sonnet-4-6"` | - | - | Fallback model when the primary is unavailable. Set to `""` to disable fallback. |
| `model.defaults.contextWindow` | integer | - | > 0, ≤ 2,000,000 | - | Override the context window (tokens) for the default model. When set, takes priority over API-fetched and SDK-reported values. Useful when the SDK reports stale data (e.g. 200K instead of 1M). Omit to use the automatically detected value. Claude only. |
| `meta.schemaVersion` | string | `"0.0.1"` | `"0.0.1"` | - | Version of the persisted settings document. A malformed or newer version blocks writes until repair or reset. |
| `terminal.defaultProfileId` | profile ID | `"automatic"` | `"automatic"`, a certified profile ID, or a configured custom profile ID | - | Profile selection for new Terminal sessions when the workspace has no explicit override. |
| `terminal.profiles` | array | `[]` | Up to 32 custom profiles | - | Custom profile definitions. Each profile contains a stable ID, name, executable, and argument list. |
| `terminal.presentation.fontFamily` | string | `"JetBrains Mono Variable", "JetBrains Mono", "SF Mono", "Cascadia Code", "Consolas", monospace` | 1-128 characters | - | Terminal font family. |
| `terminal.presentation.fontSize` | enum | `"sm"` | `"xs"` \| `"sm"` \| `"md"` \| `"lg"` \| `"xl"` | - | Terminal font size. |
| `terminal.presentation.lineHeight` | enum | `"normal"` | `"compact"` \| `"normal"` \| `"relaxed"` | - | Terminal line spacing. |
| `terminal.presentation.cursorStyle` | enum | `"block"` | `"block"` \| `"underline"` \| `"bar"` | - | Terminal cursor shape. |
| `terminal.presentation.cursorBlink` | boolean | `false` | - | - | Whether the Terminal cursor blinks. |
| `terminal.presentation.ligatures` | boolean | `false` | - | - | Whether the Terminal uses font ligatures. |
| `terminal.behavior.scrollback` | integer | `1000` | 100-5000 | - | Number of scrollback lines to retain. |
| `terminal.behavior.sessionLimit` | integer | `20` | 1-20 | - | App-wide Terminal session capacity. |
| `terminal.behavior.confirmOnKill` | enum | `"withChildProcesses"` | `"never"` \| `"withChildProcesses"` \| `"always"` | - | When Mcode asks before it closes a Terminal session. |
| `terminal.behavior.copyOnSelect` | boolean | `false` | - | - | Whether selecting Terminal text copies it. |
| `terminal.behavior.confirmMultilinePaste` | boolean | `true` | - | - | Whether Mcode asks before a multiline paste. |
| `terminal.accessibility.screenReaderMode` | enum | `"off"` | `"off"` \| `"auto"` \| `"on"` | - | Terminal screen reader mode. |
| `notifications.enabled` | boolean | `true` | - | - | Whether desktop notifications are enabled |
| `thread.completion.retentionDays` | number \| null | `3` | 1 | 365 | Days to retain completed threads. Use `null` to disable automatic deletion. |
| `updates.channel` | enum | `"stable"` | `"stable"` \| `"nightly"` | - | Desktop auto-update release line. Stable uses normal GitHub releases; nightly uses the maintainers' prerelease channel when CI publishes it. **Channel switch behavior:** Stable to Nightly, electron-updater checks the latest per-build nightly release and offers it as an available update with `allowPrerelease` enabled. Nightly to Stable, if the running version is newer than the latest stable, the app shows a confirmation dialog. Confirming triggers a one-shot downgrade install. Cancelling leaves you on nightly. Per-build nightly releases are tagged `v<version>-nightly.<YYYYMMDD>.<runNumber>` and marked as GitHub prereleases. The "Latest" badge on the repo always points to the most recent stable. |
| `updates.autoDownload` | boolean | `true` | - | - | Download updates automatically when available |
| `updates.autoInstallOnQuit` | boolean | `true` | - | - | Install downloaded updates when the app quits |
| `updates.checkInterval` | enum | `"4hours"` | `"15min"` \| `"1hour"` \| `"4hours"` \| `"1day"` \| `"never"` | - | How often the desktop app checks for updates. Check interval is applied at launch; other update options re-read from disk on each check. |
| `server.memory.heapMb` | integer | `512` | 256-8192 | `MCODE_SERVER_HEAP_MB` | Electron uses this as the V8 old-space cap and applies changes after restart. Bun uses it as a soft process-RSS budget for server admission and shedding and applies saved settings immediately. The environment override applies to the Electron launch. Invalid environment values fall through to `settings.json`. |
| `preview.memorySaver.maxWarm` | integer | `3` | 1-20 | - | Most-recently-used background preview tabs kept warm while the panel is hidden. Others are discarded (renderer freed) and reload on reopen. |
| `preview.memorySaver.bgIdleMs` | integer | `300000` | 30000-3600000 | - | Idle time (ms) before a background preview tab is discarded while the panel is visible. |
| `preview.memorySaver.hiddenIdleMs` | integer | `60000` | 5000-600000 | - | Idle time (ms) after the preview panel hides before the warm set is trimmed to `maxWarm`. A reshow within the window cancels the trim. |
| `provider.cli.codex` | string | `""` | - | - | Path to the Codex CLI binary. When empty, mcode looks for `codex` on the system PATH. |
| `provider.cli.claude` | string | `""` | - | - | Path to the Claude Code CLI binary. When empty, mcode looks for `claude` on the system PATH. |
| `provider.cursor.alwaysSendFullInstructions` | boolean | `false` | - | - | When true, Cursor ACP sends full stitched workspace guidance and the skill catalogue on every turn instead of sticky shortening (largest prompts). |
| `provider.cursor.fullPreambleEveryNTurns` | integer | `12` | 0-999 | - | With sticky shortening, force a fresh full preamble every N prompts for that subprocess. `0` turns this off. |
| `provider.cursor.idleSessionTtlMinutes` | integer | `20` | 5-240 | - | Idle minutes before tearing down an unused `cursor-agent` subprocess. |
| `provider.cursor.retryTransientFailuresOnce` | boolean | `true` | - | - | Retry `session/prompt` once when the failure looks like a transient CLI or HTTP transport flake. |
| `provider.cursor.rateLimitRetryBackoffMs` | integer | `3000` | 0-60000 | - | Base delay before the single retry of a `resource_exhausted` rate-limited prompt. A random jitter of 0-2000ms is added so concurrent turns do not retry in lockstep. The wait is invisible in the thread (reads as normal model latency); a Stop ends it early. |
| `provider.cursor.verboseFailureLogs` | boolean | `true` | - | - | On Cursor prompt failure, append recent stderr lines to structured logs when available. |
| `provider.cursor.traceSessionUpdates` | boolean | `false` | - | - | When true, writes sanitized Cursor ACP `session/update` payloads and mapped agent events to daily server logs (skips noisy `agent_message_chunk` streaming). Inspect `$MCODE_DATA_DIR/logs/` for timelines. |
| `provider.cursor.autoAnswerAskQuestions` | boolean | `true` | - | - | For blocking `cursor/ask_question`, auto-select recommended or first selectable options. When false, answer as skipped only. |
| `provider.cursor.echoAskQuestionsToTimeline` | boolean | `false` | - | - | When auto answers run, emit a short synthetic system subtype on the timeline. Server logs always record resolutions. |
| `provider.cursor.usageEmail` | string | `""` | - | `MCODE_CURSOR_ADMIN_API_KEY` supplies the secret key | Cursor team member email used for Admin API usage lookup. Empty disables Cursor account-limit usage. |
| `prDraft.provider` | string | `""` | `""` \| `"claude"` \| `"codex"` \| `"gemini"` \| `"copilot"` | - | AI provider for PR draft generation. Empty string inherits from `model.defaults.provider`. |
| `prDraft.model` | string | `""` | - | - | Model for AI PR draft generation. Empty string uses a provider-appropriate default (`claude-haiku-4-5-20251001` for Claude, `gpt-5.1-codex-mini` for Codex). |
| `externalApps.defaultEditor` | string | `""` | - | - | Global default open-in app id (registry id, e.g. `"code"`). Tier 2 of the three-tier open-in resolution (ADR-0005). Set from Settings > External Apps. `""` auto-resolves to the highest-priority installed editor, falling back to File Explorer. |
