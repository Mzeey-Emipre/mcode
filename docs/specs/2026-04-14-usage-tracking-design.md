# Usage Tracking and Quota Display

**Issue:** #261
**Date:** 2026-04-14
**Status:** Design

## Problem

Users juggle multiple AI providers with different billing models. Without visible usage data, they cannot judge when to switch models or providers. Each provider reports usage differently, but the UI should present a unified view.

## Decision: Ring-Anchored Popover (Option I)

The existing context window ring in the Composer becomes the single entry point for all usage information. Click it to open a structured popover with three sections: Quota, Context Window, and Last Turn token breakdown.

**Why this approach:**
- Zero new UI chrome - reuses the element users already watch
- One click for full detail, zero clicks for the ambient ring signal
- Adapts per provider - sections hide when data is unavailable
- A red dot badge on the ring warns when quota drops below 20%, independent of context fill

**Rejected alternatives:**
- Right sidebar tab - too much screen real estate for data checked occasionally
- Inline status bar chips - Composer bar has limited horizontal space, scales poorly to multiple providers
- Turn receipts in chat stream - adds visual noise to every conversation
- Dedicated settings page - not visible while working

## Provider-Agnostic Contract

Defined in `packages/contracts/src/providers/`. The frontend renders one shape regardless of provider.

### TurnUsage

Per-turn token breakdown. All providers can populate at least `inputTokens` and `outputTokens`.

```ts
interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMultiplier?: number;       // Copilot billing multiplier (1x, 0.33x, 30x)
}
```

### QuotaCategory

A single quota bucket (e.g. "Premium requests", "Chat").

```ts
interface QuotaCategory {
  label: string;                 // Display name
  used: number;
  total: number | null;          // null = unlimited
  remainingPercent: number;      // 0.0 to 1.0
  resetDate?: string;            // ISO 8601
  isUnlimited: boolean;
}
```

### ProviderUsageInfo

Top-level usage state per provider. This is what the popover renders for quota and cost. Context window data is **not** duplicated here - the popover reads context data from the existing `contextByThread` store (populated by `contextEstimate` and `turnComplete` events).

```ts
interface ProviderUsageInfo {
  providerId: ProviderId;
  quotaCategories: QuotaCategory[];  // empty = "quota not available"
  sessionCostUsd?: number;           // Claude only (accumulated)
}
```

`lastTurn` is also thread-scoped, not provider-scoped. The popover reads the active thread's most recent turn data from `contextByThread` (extended with token breakdown fields - see Frontend Changes).

### Provider mapping

| Field | Copilot | Claude | Codex |
|-------|---------|--------|-------|
| `quotaCategories` | `quotaSnapshots` from `assistant.usage` keyed by "chat", "completions", "premium_interactions" | Empty (no quota API accessible through SDK) | Empty (rate limit notifications exist but have no documented schema) |
| `sessionCostUsd` | Not available (`null`) | `result.total_cost_usd` (accumulated session total) | Not available (`null`) |
| `TurnComplete.cacheReadTokens` | `assistant.usage.cacheReadTokens` (already extracted) | `cache_read_input_tokens` | `cached_input_tokens` |
| `TurnComplete.cacheWriteTokens` | `assistant.usage.cacheWriteTokens` (present in SDK types, not yet destructured in handler) | `cache_creation_input_tokens` | Not available |
| `TurnComplete.costMultiplier` | `assistant.usage.cost` | Not applicable | Not applicable |
| Context (existing path) | `session.usage_info` → `contextEstimate` event → `contextByThread` | `message_start.usage` → `contextEstimate` → `contextByThread` | Not available |

## Data Flow

### Fetch strategy: initial hydration + piggybacked updates

Two data paths, no polling:

1. **Initial hydration** - On session start (or first popover open), call `provider.getUsage` RPC. For Copilot this delegates to `client.rpc.account.getQuota()`. For Claude and Codex, it returns whatever accumulated state exists (cost, last turn tokens).

2. **Per-turn updates** - After each assistant reply, the provider emits a `quotaUpdate` AgentEvent with fresh quota data extracted from the response. The Copilot SDK's `assistant.usage` event already includes `quotaSnapshots` - we just need to extract and normalize them. Claude and Codex emit `quotaUpdate` with empty categories but populated turn/cost fields.

This covers the low-quota warning requirement: quota is checked after every turn, so warnings fire without polling.

### New AgentEvent: `quotaUpdate`

```ts
{
  type: "quotaUpdate",
  threadId: string,
  providerId: ProviderId,
  categories: QuotaCategory[],
  sessionCostUsd?: number,       // Claude: updated from result.total_cost_usd each turn
}
```

Rides the existing `agent.event` push channel. The `providerId` field lets the frontend aggregate at the provider level despite the event being thread-scoped. The `agent-service` layer injects `providerId` before broadcasting - it already knows which provider emitted the event because it subscribes to each provider individually.

### New RPC: `provider.getUsage`

```ts
"provider.getUsage": {
  params: { providerId: ProviderIdSchema },
  result: ProviderUsageInfoSchema,
}
```

Server-side handler delegates to each provider's native API. Copilot calls `account.getQuota()`, Claude returns accumulated session state, Codex returns what it has.

### Extended TurnComplete event

Add optional fields to the existing `TurnComplete` AgentEvent:

```ts
{
  // ... existing fields (tokensIn, tokensOut, costUsd, contextWindow, totalProcessedTokens)
  cacheReadTokens?: number,
  cacheWriteTokens?: number,
  costMultiplier?: number,
  providerId?: ProviderId,
}
```

## Server-Side Changes

### Copilot provider

1. **`assistant.usage` handler** - Extend to extract `cacheWriteTokens`, `cost` (multiplier), and `quotaSnapshots` from `event.data`. Normalize `quotaSnapshots` into `QuotaCategory[]` and emit `quotaUpdate`.
2. **Session start** - Call `client.rpc.account.getQuota()` once after session initialization. Emit `quotaUpdate` with the result.
Note: The Copilot SDK also emits a `session.shutdown` event with `totalPremiumRequests` and per-model `modelMetrics`. Handling this is out of scope for this feature but could support a session summary view in future work.

### Claude provider

1. **`result` handler** - Populate `cacheReadTokens` (from `cache_read_input_tokens`) and `cacheWriteTokens` (from `cache_creation_input_tokens`) on the `TurnComplete` event.

### Codex provider

1. **`turn/completed` handler** - Break out `cached_input_tokens` as `cacheReadTokens` on `TurnComplete` instead of folding it into `tokensIn`.

### RPC handler

Add `provider.getUsage` case in `ws-router.ts`. Add an optional `getUsage?(): Promise<ProviderUsageInfo>` method to the `IAgentProvider` interface, following the same pattern as `listModels?()`. Providers that support usage reporting implement it; the RPC handler checks for the method and returns a `ProviderUsageInfo` with empty `quotaCategories` and no `sessionCostUsd` if the method is absent. Use `ProviderIdSchema` from `providers/interfaces.ts` (which covers all provider IDs including `cursor` and `opencode`) for the RPC param and contract types.

## Frontend Changes

### Store: `threadStore` extension

Add to existing `threadStore`:

```ts
usageByProvider: Record<ProviderId, ProviderUsageInfo>
```

Extend the existing `contextByThread` entry type to include the new per-turn fields:

```ts
contextByThread: Record<string, {
  lastTokensIn: number;
  contextWindow?: number;
  totalProcessedTokens?: number;
  // New fields:
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMultiplier?: number;
}>
```

The `handleAgentEvent` dispatcher gets:
- `quotaUpdate` case: updates `usageByProvider[event.providerId].quotaCategories`
- `turnComplete` case (extended): updates `contextByThread[threadId]` with the new cache/multiplier fields alongside the existing token fields. Note: the Copilot provider currently folds `cacheReadTokens` into `tokensIn` before emitting `TurnComplete`. This changes - `tokensIn` will carry only `inputTokens`, and `cacheReadTokens` becomes a separate field. The same separation applies to Claude and Codex.

**Hydration trigger:** The frontend calls `provider.getUsage` RPC when the popover opens for the first time (lazy). The result is cached in `usageByProvider`. Subsequent turns keep it fresh via `quotaUpdate` events. No server-push on session start.

### New component: `UsagePopover.tsx`

A Radix popover anchored to the context ring. Three sections that show or hide based on available data:

**Quota section** - Renders each `QuotaCategory` as a label + progress bar + used/total. Hidden when `quotaCategories` is empty, replaced with "Quota data not available for this provider."

**Context window section** - Reads from the existing `contextByThread[activeThreadId]` store. Shows `lastTokensIn / contextWindow` as a progress bar. Hidden when `contextWindow` is undefined (Codex).

**Last turn section** - Reads from `contextByThread[activeThreadId]`. A 2x2 grid of token counts (in, out, cache read, cache write). Shows after the first turn completes.

**Provider header** - Shows provider name, current model (from thread state), cost multiplier if available, and days until quota reset.

**Per-provider rendering:**
- Copilot: all sections visible (quota, context, last turn)
- Claude: no quota section, shows session cost instead, context + last turn
- Codex: no quota, no context, last turn only + "Usage data limited for this provider"

### ContextTracker changes

- Add `onClick` handler to the ring SVG to toggle the popover. The existing `TooltipTrigger` wrapper remains for hover - when the popover is closed, hovering shows the tooltip as before. When the popover is open, the tooltip is suppressed (set `Tooltip` `open={false}` while popover is visible).
- Add a red dot badge (8px circle) when any `QuotaCategory.remainingPercent < 0.20`
- Ring color continues to reflect context window fill only - the badge is the quota signal

### Composer wiring

Add popover state management in `Composer.tsx`. The `UsagePopover` renders as a child of the ring area.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `account.getQuota()` throws on session start | Log server-side, skip `quotaUpdate` emission. Popover shows empty quota until first turn provides `quotaSnapshots`. |
| `provider.getUsage` RPC fails on popover open | Frontend shows last known state with muted "Unable to refresh" text. |
| Popover opened before first turn | Context data from `contextEstimate` events (already flowing). Quota shows initial hydration. Last turn section shows "No turn data yet." |
| Provider switched mid-session | `usageByProvider` is keyed by provider ID. Switching renders a different entry. Old provider data persists. |
| Multiple threads, same provider | Quota is provider-scoped - all threads share the same `usageByProvider[providerId]` entry. Last turn and context are thread-scoped - the popover shows data for the active thread. |
| Provider not configured | `provider.getUsage` returns error. Popover shows "Provider not configured." |

## What This Does Not Include

- **Usage history or trends.** No historical data, no charts. Per-turn data is transient.
- **New database tables or migrations.** Quota is refreshed every turn. Per-turn tokens flow through events.
- **Cost estimation for Copilot.** The SDK reports `totalNanoAiu` but there is no USD conversion. The `costMultiplier` is shown as a raw number.
- **Codex rate limit capture.** The `account/rateLimits/updated` notification exists but has no documented payload schema. We skip it until the schema stabilizes.
- **Anthropic rate limit headers.** Not accessible through the Claude Agent SDK subprocess.
- **Copilot `session.shutdown` handling.** The SDK provides session-level aggregates (`totalPremiumRequests`, per-model `modelMetrics`) on shutdown. Useful for a future session summary view but out of scope here.

## Files Changed

| Package | File | Change |
|---------|------|--------|
| `packages/contracts` | `providers/usage.ts` (new) | `TurnUsage`, `QuotaCategory`, `ProviderUsageInfo` schemas |
| `packages/contracts` | `events/agent-event.ts` | Add `quotaUpdate` event type, extend `TurnComplete` with cache/multiplier fields |
| `packages/contracts` | `ws/methods.ts` | Add `provider.getUsage` RPC |
| `apps/server` | `providers/copilot/copilot-provider.ts` | Extract `quotaSnapshots`, `cacheWriteTokens`, `cost` from `assistant.usage`; call `account.getQuota()` on session start |
| `apps/server` | `providers/claude/claude-provider.ts` | Populate cache token fields on `TurnComplete` |
| `apps/server` | `providers/codex/codex-event-mapper.ts` | Break out `cached_input_tokens` as `cacheReadTokens` |
| `apps/server` | `transport/ws-router.ts` | Handle `provider.getUsage` RPC |
| `apps/web` | `stores/threadStore.ts` | Add `usageByProvider`, handle `quotaUpdate` and extended `turnComplete` |
| `apps/web` | `components/chat/UsagePopover.tsx` (new) | Popover component with quota/context/turn sections |
| `apps/web` | `components/chat/ContextTracker.tsx` | Add click handler, low-quota badge |
| `apps/web` | `components/chat/Composer.tsx` | Wire popover state |
