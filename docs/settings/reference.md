# Settings Reference

Per-setting reference for Mcode's `settings.json`. For schema conventions and structure rules, see [settings-schema.md](../guides/settings-schema.md).

**Location:** `~/.mcode/settings.json`

## Terminal v1 target (frozen, implementation pending)

The following versioned shape is the v1 contract. It is documented here for
implementation and migration work; the current runtime still reads the legacy
row identified in the table below.

```json
{
  "meta": { "schemaVersion": "0.0.1" },
  "terminal": {
    "defaultProfileId": "automatic",
    "profiles": [],
    "presentation": {
      "fontFamily": "mcodeMono",
      "fontSize": "sm",
      "lineHeight": "normal",
      "cursorStyle": "block",
      "cursorBlink": false,
      "ligatures": false
    },
    "behavior": {
      "scrollback": 1000,
      "sessionLimit": 20,
      "confirmOnKill": "withChildProcesses",
      "copyOnSelect": false,
      "confirmMultilinePaste": true
    },
    "accessibility": { "screenReaderMode": "off" },
    "flowControl": {
      "serverHighBytes": 1048576,
      "serverLowBytes": 262144,
      "clientHighBytes": 262144,
      "clientLowBytes": 65536
    }
  }
}
```

`fontSize` is `xs|sm|md|lg|xl`; `lineHeight` is `compact|normal|relaxed`;
`cursorStyle` is `block|underline|bar`; `screenReaderMode` is `off|auto|on`;
and `confirmOnKill` is `never|withChildProcesses|always`. `scrollback` is
100..5000 lines with default 1000. Legacy scrollback `0` migrates to 5000.
`sessionLimit` is app-wide, 1..20, with default 20. Flow-control values are
fixed operational values and are not normal settings controls.

Custom `profiles` contain only a server-generated `id`, `name`, `executable`,
and `arguments`; they never contain environment values or a working directory.
At most 32 custom profiles are stored. Names are 1..64 trimmed characters,
executables are 1..1024 characters, and arguments contain at most 32 entries
with each entry at most 1024 characters and 8 KiB total.
The frozen workspace preference row stores `workspaceId`,
`defaultProfileId`, and `updatedAt`; no row means inherit.

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
| `terminal.scrollback` (legacy v0 only) | integer | `1000` | >= 0 | - | Current legacy client setting. Values above 5000 clamp to 5000; `0` means legacy unlimited scrollback. Not part of the v1 shape; migrate into `terminal.behavior.scrollback` and map legacy `0` to `5000`. |
| `notifications.enabled` | boolean | `true` | - | - | Whether desktop notifications are enabled |
| `updates.channel` | enum | `"stable"` | `"stable"` \| `"nightly"` | - | Desktop auto-update release line. Stable uses normal GitHub releases; nightly uses the maintainers' prerelease channel when CI publishes it. **Channel switch behavior:** Stable to Nightly, electron-updater checks the latest per-build nightly release and offers it as an available update with `allowPrerelease` enabled. Nightly to Stable, if the running version is newer than the latest stable, the app shows a confirmation dialog. Confirming triggers a one-shot downgrade install. Cancelling leaves you on nightly. Per-build nightly releases are tagged `v<version>-nightly.<YYYYMMDD>.<runNumber>` and marked as GitHub prereleases. The "Latest" badge on the repo always points to the most recent stable. |
| `updates.autoDownload` | boolean | `true` | - | - | Download updates automatically when available |
| `updates.autoInstallOnQuit` | boolean | `true` | - | - | Install downloaded updates when the app quits |
| `updates.checkInterval` | enum | `"4hours"` | `"15min"` \| `"1hour"` \| `"4hours"` \| `"1day"` \| `"never"` | - | How often the desktop app checks for updates. Check interval is applied at launch; other update options re-read from disk on each check. |
| `performance.threadCacheSize` | integer | `10` | 1-25 | - | Number of threads to keep in memory for instant switching. Lower values reduce memory use; values ≤ 3 mean most thread switches reload from the server. Takes effect immediately. |
| `server.memory.heapMb` | integer | `512` | 256-8192 | `MCODE_SERVER_HEAP_MB` | V8 max old space for the server process (MB). Invalid environment values fall through to `settings.json`. |
| `preview.rendering.engine` | enum | `"webContentsView"` | `"webContentsView"` \| `"webview"` | - | Hidden preview compositing switch. `"webContentsView"` uses the native preview path. `"webview"` uses the renderer-hosted webview path so React overlays can remain above the page. |
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
