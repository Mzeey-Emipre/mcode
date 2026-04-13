# GitHub Copilot Provider

## Overview

Add GitHub Copilot as a third AI provider in Mcode, wrapping the `@github/copilot-sdk` package (v0.2.2+). The SDK communicates with the `@github/copilot` CLI via JSON-RPC over stdio. Users authenticate through the CLI before using the app (`gh auth login` or `copilot auth login`). The implementation follows the existing Codex provider as a template since both SDKs share nearly identical patterns (client/session model, event streaming, session resume).

## Motivation

Copilot gives users access to 17 models from four vendors (OpenAI, Anthropic, Google, xAI) through a single provider, all covered by their existing GitHub Copilot subscription. No separate API keys needed.

## Architecture

```
CopilotProvider (implements IAgentProvider)
  └── CopilotClient (from @github/copilot-sdk)
       └── spawns @github/copilot CLI via JSON-RPC over stdio
            └── uses gh CLI auth (pre-authenticated by user)
```

**File:** `apps/server/src/providers/copilot/copilot-provider.ts` (~350 lines, forked from `codex-provider.ts`)

**Key difference from Codex:** The Copilot SDK uses callback-based events (`session.on("event.type", handler)`) instead of Codex's async iterator (`for await (const event of events)`). The `runTurn()` method registers event handlers before calling `session.send()`, then resolves a promise when `session.idle` fires.

## SDK Integration

### CopilotClient Lifecycle

```typescript
import { CopilotClient, approveAll } from "@github/copilot-sdk";

// One client per provider instance (singleton)
const client = new CopilotClient({
  cliPath: settings.provider.cli.copilot || undefined, // auto-discover if empty
  useLoggedInUser: true,
});
await client.start();
```

### Session Lifecycle

```typescript
// Create
const session = await client.createSession({
  model: "claude-sonnet-4.5",
  workingDirectory: cwd,
  onPermissionRequest: approveAll,
  streaming: true,
});

// Send message (fire-and-forget, events arrive via callbacks)
await session.send({ prompt: message });

// Resume
const resumed = await client.resumeSession(sdkSessionId, {
  onPermissionRequest: approveAll,
});

// Abort
await session.abort();

// Cleanup
await session.disconnect();
await client.stop();
```

### Permission Handling

Copilot requires an `onPermissionRequest` callback on every `createSession`/`resumeSession`. Unlike Codex's `sandboxMode` string, Copilot delegates permission decisions to this callback. For v1, we use `approveAll` from the SDK regardless of Mcode's `permissionMode` setting. The Copilot CLI handles its own sandboxing.

## Event Mapping

Direct 1:1 mapping from Copilot SDK events to the AgentEvent union:

| AgentEvent | Copilot SDK Event | Data |
|---|---|---|
| `textDelta` | `assistant.message_delta` | `data.deltaContent` |
| `message` | `assistant.message` | `data.content` |
| `toolUse` | `tool.execution_start` | `toolCallId`, `toolName`, `arguments` |
| `toolResult` | `tool.execution_complete` | `toolCallId`, `result`, `error` |
| `toolProgress` | `tool.execution_progress` | heartbeat |
| `turnComplete` | `assistant.turn_end` + `assistant.usage` | token counts |
| `error` | `session.error` | `data.message` |
| `ended` | `session.idle` / `session.shutdown` | always in finally |
| `system` | `session.start` | captures SDK session ID |
| `compacting` | `session.compaction_start` | lifecycle signal |
| `compactSummary` | `session.compaction_complete` | compaction result |

**Intentionally ignored:** `assistant.reasoning`, `assistant.reasoning_delta`, `permission.*`, `subagent.*`, `hook.*`, `mcp.*`, `skill.*`. No AgentEvent equivalent needed for v1.

## Session Management

Identical to Codex:

- **Idle TTL:** 10 minutes (600,000ms)
- **Eviction interval:** 1 minute (60,000ms)
- **Session map:** `Map<sessionId, { session, model, lastUsedAt, abortController?, suppressEnded? }>`
- **SDK session ID map:** `Map<sessionId, sdkSessionId>` for resume
- **Stop:** `session.abort()`, remove from map
- **Shutdown:** `client.stop()`, clear all timers

## Model Registry

17 models across 4 vendors:

| Model ID | Label | Notes |
|---|---|---|
| `gpt-5.3-codex` | GPT-5.3 Codex | |
| `gpt-5.2-codex` | GPT-5.2 Codex | |
| `gpt-5.2` | GPT-5.2 | |
| `gpt-5.1-codex` | GPT-5.1 Codex | |
| `gpt-5.1-codex-max` | GPT-5.1 Codex Max | Extended reasoning |
| `gpt-5.1` | GPT-5.1 | Closing down 2026-04-15 |
| `gpt-5-mini` | GPT-5 mini | |
| `gpt-4.1` | GPT-4.1 | |
| `claude-opus-4.6` | Claude Opus 4.6 | |
| `claude-opus-4-6-fast` | Claude Opus 4.6 Fast | Preview |
| `claude-opus-4.5` | Claude Opus 4.5 | |
| `claude-sonnet-4.6` | Claude Sonnet 4.6 | |
| `claude-sonnet-4.5` | Claude Sonnet 4.5 | |
| `claude-haiku-4.5` | Claude Haiku 4.5 | |
| `gemini-3-pro` | Gemini 3 Pro | Preview |
| `gemini-3-flash` | Gemini 3 Flash | Preview |
| `grok-code-fast-1` | Grok Code Fast 1 | |

The SDK also exposes `client.listModels()` for runtime discovery, but we hardcode the list for consistency with other providers.

## Settings Changes

### Schema (`packages/contracts/src/models/settings.ts`)

Add `copilot` to the `provider.cli` object in both `SettingsSchema` and `PartialSettingsSchema`:

```typescript
provider: z.object({
  cli: z.object({
    codex: z.string().default(""),
    claude: z.string().default(""),
    copilot: z.string().default(""),  // new
  }).default({})
}).default({})
```

### Settings UI (`apps/web/src/components/settings/sections/ModelSection.tsx`)

Add a "Copilot CLI path" input row in the CLI Paths section, following the existing Codex/Claude pattern.

## UX Changes

### Problem

The current model selection UI assumes 3-5 models per provider:

1. **Composer submenu** (`ModelSelector.tsx:101-124`): Renders all models in a vertical list with no height constraint. 17 models = ~460px, overflows most viewports.
2. **Settings model selector** (`ModelSection.tsx:170`): Uses `SegControl` (horizontal inline-flex buttons with no wrapping). 17 buttons = ~1020px, overflows the settings panel.

### Solution

**Composer submenu:** Add `max-h-[280px] overflow-y-auto` to the submenu container div (`ModelSelector.tsx:107`). This caps the list at ~10 visible items with smooth scrolling for the rest. Minimal change, no component restructuring.

**Settings model/fallback selectors:** When a provider has more than 6 models, render a `Select` dropdown (from `apps/web/src/components/ui/select.tsx`) instead of the `SegControl`. This is a conditional render in `ModelSection`, not a change to `SegControl` itself. The reasoning effort selector stays as `SegControl` since it always has 3-5 options.

### Provider Icon

Add a `CopilotIcon` component to `ProviderIcons.tsx` using the GitHub Copilot logomark SVG. Register it in both `PROVIDER_META` (ModelSelector) and `PROVIDER_ICONS` (ModelSection).

## Cross-Package Changes

| Package | File | Change |
|---|---|---|
| contracts | `src/models/settings.ts` | Add `copilot` to `provider.cli` in both schemas |
| server | `package.json` | Add `@github/copilot-sdk` dependency |
| server | `src/providers/copilot/copilot-provider.ts` | New file (forked from Codex) |
| server | `src/container.ts` | Import + register CopilotProvider |
| server | `src/services/agent-service.ts` | Add copilot case to `normalizeProviderError()` |
| web | `src/lib/model-registry.ts` | Add copilot provider + 17 models |
| web | `src/components/chat/ProviderIcons.tsx` | Add CopilotIcon |
| web | `src/components/chat/ModelSelector.tsx` | Add copilot to PROVIDER_META, scroll fix |
| web | `src/components/settings/sections/ModelSection.tsx` | Add copilot icon, CLI path row, Select for large model lists |

No changes needed to `ProviderId` or `AgentEvent` since `"copilot"` is already declared in the union.

## Error Handling

### CLI Not Found

Add copilot case to `normalizeProviderError()` in `agent-service.ts`:

```
Copilot CLI not found. Install it with: npm install -g @github/copilot
Or set a custom path in Settings > Provider > Copilot CLI path.
```

### Auth Not Configured

Check `client.getAuthStatus()` before creating sessions. If not authenticated, emit an error event:

```
GitHub Copilot is not authenticated. Run "copilot auth login" or "gh auth login" first.
```

## Out of Scope

- OAuth device flow in-app (future enhancement)
- Dynamic model discovery via `client.listModels()` (future enhancement)
- Custom tool registration via Copilot SDK
- MCP server passthrough to Copilot sessions
- Copilot-specific reasoning level mapping (uses standard levels for now)
