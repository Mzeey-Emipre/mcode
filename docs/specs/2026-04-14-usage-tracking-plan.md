# Usage Tracking and Quota Display - Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-provider usage quota and per-turn token breakdown in a popover anchored to the existing context window ring.

**Architecture:** Extend the existing `agent.event` push pipeline with a new `quotaUpdate` event type and new fields on `TurnComplete`. Add a `provider.getUsage` RPC for initial hydration. Frontend reads quota from a new `usageByProvider` map and turn data from the existing `contextByThread` (extended with cache/multiplier fields).

**Tech Stack:** TypeScript, Zod, tsyringe, Zustand, @base-ui/react/popover, @github/copilot-sdk, @anthropic-ai/claude-agent-sdk

**Spec:** `docs/specs/2026-04-14-usage-tracking-design.md`

**Dependency order:** Chunks must be executed in order. Chunk 2 (server providers) depends on Chunk 1 (contracts) being committed. Chunk 3 depends on Chunk 2. Chunk 4 depends on Chunks 1 and 3. Chunk 5 depends on all prior chunks.

---

## Chunk 1: Contracts

### Task 1: Add usage type schemas

**Files:**
- Create: `packages/contracts/src/providers/usage.ts`
- Modify: `packages/contracts/src/providers/models.ts` (imports reference)

- [ ] **Step 1: Create `usage.ts` with Zod schemas**

```ts
// packages/contracts/src/providers/usage.ts
import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Per-turn token breakdown. All providers populate at least inputTokens and outputTokens. */
export const TurnUsageSchema = lazySchema(() =>
  z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    costMultiplier: z.number().optional(),
  }),
);

export type TurnUsage = z.infer<ReturnType<typeof TurnUsageSchema>>;

/** A single quota bucket (e.g. "Premium requests", "Chat"). */
export const QuotaCategorySchema = lazySchema(() =>
  z.object({
    label: z.string(),
    used: z.number(),
    total: z.number().nullable(),
    remainingPercent: z.number().min(0).max(1),
    resetDate: z.string().optional(),
    isUnlimited: z.boolean(),
  }),
);

export type QuotaCategory = z.infer<ReturnType<typeof QuotaCategorySchema>>;

/** Provider-level usage state. Quota and cost only - context/turn data is thread-scoped. */
export const ProviderUsageInfoSchema = lazySchema(() =>
  z.object({
    providerId: z.string(),
    quotaCategories: z.array(QuotaCategorySchema()),
    sessionCostUsd: z.number().optional(),
  }),
);

export type ProviderUsageInfo = z.infer<ReturnType<typeof ProviderUsageInfoSchema>>;
```

- [ ] **Step 2: Verify contracts typecheck**

Run: `cd packages/contracts && npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/providers/usage.ts
git commit -m "feat: add usage tracking type schemas (TurnUsage, QuotaCategory, ProviderUsageInfo)"
```

---

### Task 2: Extend AgentEvent with quotaUpdate and TurnComplete fields

**Files:**
- Modify: `packages/contracts/src/events/agent-event.ts:12-69`

- [ ] **Step 1: Add `QuotaUpdate` to `AgentEventType` const**

In `agent-event.ts`, add a new entry inside the `AgentEventType` const object, after `ContextEstimate: "contextEstimate"` and before the closing `} as const`:

```ts
QuotaUpdate: "quotaUpdate",
```

- [ ] **Step 2: Add imports for usage schemas**

Add at the top of `agent-event.ts`:

```ts
import { QuotaCategorySchema } from "../providers/usage.js";
```

- [ ] **Step 3: Extend `TurnComplete` variant with new optional fields**

In `agent-event.ts`, the `TurnComplete` variant (lines 59-69). Replace with:

```ts
z.object({
  type: z.literal(AgentEventType.TurnComplete),
  threadId: z.string(),
  reason: z.string(),
  costUsd: z.number().nullable(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  contextWindow: z.number().optional(),
  totalProcessedTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  costMultiplier: z.number().optional(),
  providerId: z.string().optional(),
}),
```

- [ ] **Step 4: Add `QuotaUpdate` variant to the discriminated union**

Add a new variant inside the `z.discriminatedUnion("type", [...])` array, after the `ContextEstimate` variant:

```ts
z.object({
  type: z.literal(AgentEventType.QuotaUpdate),
  threadId: z.string(),
  providerId: z.string(),
  categories: z.array(QuotaCategorySchema()),
  sessionCostUsd: z.number().optional(),
}),
```

- [ ] **Step 5: Verify contracts typecheck**

Run: `cd packages/contracts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/events/agent-event.ts
git commit -m "feat: add quotaUpdate event type and extend TurnComplete with cache/multiplier fields"
```

---

### Task 3: Add `provider.getUsage` RPC method

**Files:**
- Modify: `packages/contracts/src/ws/methods.ts:375-378`

- [ ] **Step 1: Add import for ProviderUsageInfoSchema**

In `methods.ts`, add to the import block:

```ts
import { ProviderUsageInfoSchema } from "../providers/usage.js";
```

- [ ] **Step 2: Add `provider.getUsage` entry to `WS_METHODS`**

Add after the `provider.listModels` entry (line 378):

```ts
"provider.getUsage": {
  params: z.object({ providerId: ProviderIdSchema }),
  result: ProviderUsageInfoSchema(),
},
```

- [ ] **Step 3: Verify contracts typecheck**

Run: `cd packages/contracts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/ws/methods.ts
git commit -m "feat: add provider.getUsage RPC method to WS_METHODS"
```

---

## Chunk 2: Server - Provider Changes

### Task 4: Add `getUsage` to `IAgentProvider` interface

**Files:**
- Modify: `packages/contracts/src/providers/interfaces.ts:47`

- [ ] **Step 1: Add import for ProviderUsageInfo**

```ts
import type { ProviderUsageInfo } from "./usage.js";
```

- [ ] **Step 2: Add optional `getUsage` method after `listModels` (line 47)**

```ts
/** Return current usage/quota state for this provider. */
getUsage?(): Promise<ProviderUsageInfo>;
```

- [ ] **Step 3: Verify contracts typecheck**

Run: `cd packages/contracts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/providers/interfaces.ts
git commit -m "feat: add optional getUsage method to IAgentProvider interface"
```

---

### Task 5: Extend Copilot provider - extract quota and cache fields

**Files:**
- Modify: `apps/server/src/providers/copilot/copilot-provider.ts:508-525`
- Test: `apps/server/src/providers/copilot/__tests__/copilot-provider.test.ts` (create if needed)

- [ ] **Step 1: Write test for quotaUpdate emission from assistant.usage**

Create or extend the test file. Test that when `assistant.usage` fires with `quotaSnapshots`, the provider emits both a `turnComplete` and a `quotaUpdate` event with normalized `QuotaCategory[]`.

```ts
it("emits quotaUpdate with normalized categories from assistant.usage quotaSnapshots", () => {
  // Arrange: mock session that fires assistant.usage with quotaSnapshots
  const events: AgentEvent[] = [];
  provider.on("event", (e) => events.push(e));

  // Act: trigger assistant.usage with quotaSnapshots
  fireAssistantUsage({
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    cost: 1,
    quotaSnapshots: {
      premium_interactions: {
        isUnlimitedEntitlement: false,
        entitlementRequests: 300,
        usedRequests: 142,
        usageAllowedWithExhaustedQuota: false,
        overage: 0,
        overageAllowedWithExhaustedQuota: false,
        remainingPercentage: 0.527,
        resetDate: "2026-04-21T00:00:00Z",
      },
      chat: {
        isUnlimitedEntitlement: true,
        entitlementRequests: 0,
        usedRequests: 89,
        usageAllowedWithExhaustedQuota: true,
        overage: 0,
        overageAllowedWithExhaustedQuota: false,
        remainingPercentage: 1.0,
      },
    },
  });

  // Assert: quotaUpdate emitted
  const quotaEvent = events.find((e) => e.type === "quotaUpdate");
  expect(quotaEvent).toBeDefined();
  expect(quotaEvent.providerId).toBe("copilot");
  expect(quotaEvent.categories).toHaveLength(2);
  expect(quotaEvent.categories[0]).toMatchObject({
    label: "Premium requests",
    used: 142,
    total: 300,
    remainingPercent: 0.527,
    isUnlimited: false,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run --reporter verbose copilot-provider`
Expected: FAIL (quotaUpdate event type not yet emitted)

- [ ] **Step 3: Add quota normalization helper**

In `copilot-provider.ts`, add a private method or module-level function:

```ts
import type { QuotaCategory } from "@mcode/contracts/providers/usage.js";
import { AgentEventType } from "@mcode/contracts/events/agent-event.js";

const QUOTA_LABELS: Record<string, string> = {
  premium_interactions: "Premium requests",
  chat: "Chat",
  completions: "Completions",
};

interface QuotaSnapshot {
  isUnlimitedEntitlement?: boolean;
  entitlementRequests?: number;
  usedRequests?: number;
  remainingPercentage?: number;
  resetDate?: string;
  overage?: number;
  overageAllowedWithExhaustedQuota?: boolean;
  usageAllowedWithExhaustedQuota?: boolean;
}

function normalizeQuotaSnapshots(
  snapshots: Record<string, QuotaSnapshot>,
): QuotaCategory[] {
  return Object.entries(snapshots).map(([key, snap]) => ({
    label: QUOTA_LABELS[key] ?? key,
    used: snap.usedRequests ?? 0,
    total: snap.isUnlimitedEntitlement ? null : (snap.entitlementRequests ?? 0),
    remainingPercent: snap.remainingPercentage ?? 1.0,
    resetDate: snap.resetDate,
    isUnlimited: snap.isUnlimitedEntitlement ?? false,
  }));
}
```

- [ ] **Step 4: Extend the `assistant.usage` handler (lines 508-525)**

Replace the existing handler:

```ts
// assistant.usage — token counts + quota after a model call
unsubscribers.push(
  session.on("assistant.usage", (event) => {
    const {
      inputTokens = 0,
      outputTokens = 0,
      cacheReadTokens = 0,
      cacheWriteTokens = 0,
      cost,
      quotaSnapshots,
    } = event.data;
    const contextWindow = this.contextWindowBySession.get(sessionId);

    this.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: inputTokens,
      tokensOut: outputTokens,
      contextWindow,
      totalProcessedTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costMultiplier: cost,
      providerId: "copilot",
    } satisfies AgentEvent);

    // Emit quota update if snapshots present
    if (quotaSnapshots && typeof quotaSnapshots === "object") {
      this.emit("event", {
        type: AgentEventType.QuotaUpdate,
        threadId,
        providerId: "copilot",
        categories: normalizeQuotaSnapshots(quotaSnapshots as Record<string, QuotaSnapshot>),
      } satisfies AgentEvent);
    }
  }),
);
```

Note: `tokensIn` now carries only `inputTokens` (not `inputTokens + cacheReadTokens`). `cacheReadTokens` is a separate field. This is a breaking change to the semantics of `tokensIn` for Copilot.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/server && npx vitest run --reporter verbose copilot-provider`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/providers/copilot/copilot-provider.ts
git add apps/server/src/providers/copilot/__tests__/
git commit -m "feat(copilot): extract quotaSnapshots, cacheWriteTokens, costMultiplier from assistant.usage"
```

---

### Task 6: Copilot provider - implement `getUsage` and initial quota hydration

**Files:**
- Modify: `apps/server/src/providers/copilot/copilot-provider.ts`

- [ ] **Step 1: Write test for getUsage RPC**

```ts
it("getUsage returns normalized quota from account.getQuota", async () => {
  // Mock client.rpc.account.getQuota to return test data
  const usage = await provider.getUsage();
  expect(usage.providerId).toBe("copilot");
  expect(usage.quotaCategories).toHaveLength(2);
  expect(usage.sessionCostUsd).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run --reporter verbose copilot-provider`
Expected: FAIL

- [ ] **Step 3: Implement `getUsage` method**

Add to the `CopilotProvider` class:

```ts
async getUsage(): Promise<ProviderUsageInfo> {
  try {
    await this.refreshClient();
    const result = await this.client!.rpc.account.getQuota();
    const categories = result?.quotaSnapshots
      ? normalizeQuotaSnapshots(result.quotaSnapshots)
      : [];
    return { providerId: "copilot", quotaCategories: categories };
  } catch (error) {
    logger.warn("Failed to fetch Copilot quota", { error });
    return { providerId: "copilot", quotaCategories: [] };
  }
}
```

Add the import for `ProviderUsageInfo`:
```ts
import type { ProviderUsageInfo } from "@mcode/contracts/providers/usage.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run --reporter verbose copilot-provider`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/providers/copilot/copilot-provider.ts
git commit -m "feat(copilot): implement getUsage with account.getQuota delegation"
```

---

### Task 7: Extend Claude provider - populate cache token fields

**Files:**
- Modify: `apps/server/src/providers/claude/claude-provider.ts:658-670`

- [ ] **Step 1: Write test for cache tokens on TurnComplete**

```ts
it("includes cacheReadTokens and cacheWriteTokens on TurnComplete", () => {
  const events: AgentEvent[] = [];
  provider.on("event", (e) => events.push(e));

  // Fire a result message with cache token fields in usage
  fireResult({
    subtype: "success",
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
    },
    modelUsage: {},
  });

  const tc = events.find((e) => e.type === "turnComplete");
  expect(tc).toBeDefined();
  expect(tc!.cacheReadTokens).toBe(200);
  expect(tc!.cacheWriteTokens).toBe(30);
  expect(tc!.providerId).toBe("claude");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run --reporter verbose claude-provider`
Expected: FAIL

- [ ] **Step 3: Extend the `result` handler TurnComplete emission (lines 658-670)**

Replace the `this.emit("event", { ... })` block:

```ts
this.emit("event", {
  type: AgentEventType.TurnComplete,
  threadId,
  reason:
    (anyMsg.stop_reason as string) ||
    (anyMsg.subtype as string) ||
    "end_turn",
  costUsd: (anyMsg.total_cost_usd as number) ?? null,
  tokensIn,
  tokensOut: usage.output_tokens ?? 0,
  contextWindow: sdkContextWindow,
  totalProcessedTokens,
  cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
  cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
  providerId: "claude",
} satisfies AgentEvent);
```

Also emit a `quotaUpdate` for session cost:

```ts
this.emit("event", {
  type: AgentEventType.QuotaUpdate,
  threadId,
  providerId: "claude",
  categories: [],
  sessionCostUsd: (anyMsg.total_cost_usd as number) ?? undefined,
} satisfies AgentEvent);
```

- [ ] **Step 4: Add `lastSessionCostUsd` class field and update it**

Add to the class fields:

```ts
private lastSessionCostUsd?: number;
```

In the `result` handler, after the line that reads `total_cost_usd` (line 665: `costUsd: (anyMsg.total_cost_usd as number) ?? null`), add:

```ts
this.lastSessionCostUsd = (anyMsg.total_cost_usd as number) ?? undefined;
```

- [ ] **Step 5: Implement `getUsage` on Claude provider**

```ts
async getUsage(): Promise<ProviderUsageInfo> {
  return {
    providerId: "claude",
    quotaCategories: [],
    sessionCostUsd: this.lastSessionCostUsd,
  };
}
```

Add the import:
```ts
import type { ProviderUsageInfo } from "@mcode/contracts/providers/usage.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/server && npx vitest run --reporter verbose claude-provider`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/providers/claude/claude-provider.ts
git commit -m "feat(claude): add cache token fields to TurnComplete and implement getUsage"
```

---

### Task 8: Extend Codex provider - separate cacheReadTokens

**Files:**
- Modify: `apps/server/src/providers/codex/codex-event-mapper.ts:91-110`

- [ ] **Step 1: Write test for separated cache tokens**

```ts
it("reports cached_input_tokens as cacheReadTokens instead of folding into tokensIn", () => {
  const events = mapper.map({
    method: "turn/completed",
    params: {
      turn: {
        status: "completed",
        usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 80 },
      },
    },
  });
  const tc = events.find((e) => e.type === "turnComplete");
  expect(tc.tokensIn).toBe(100);        // NOT 150
  expect(tc.cacheReadTokens).toBe(50);
  expect(tc.tokensOut).toBe(80);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run --reporter verbose codex-event-mapper`
Expected: FAIL

- [ ] **Step 3: Update the `turn/completed` handler (lines 91-110)**

Replace:

```ts
const tokensIn = (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
const tokensOut = usage.output_tokens ?? 0;
const totalProcessedTokens = tokensIn + tokensOut;
```

With:

```ts
const inputTokens = usage.input_tokens ?? 0;
const cachedInputTokens = usage.cached_input_tokens ?? 0;
const tokensIn = inputTokens;
const tokensOut = usage.output_tokens ?? 0;
const totalProcessedTokens = inputTokens + cachedInputTokens + tokensOut;
```

And update the TurnComplete emission:

```ts
events.push({
  type: AgentEventType.TurnComplete,
  threadId: this.threadId,
  reason: "end_turn",
  costUsd: null,
  tokensIn,
  tokensOut,
  contextWindow: undefined,
  totalProcessedTokens,
  cacheReadTokens: cachedInputTokens || undefined,
  providerId: "codex",
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run --reporter verbose codex-event-mapper`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/providers/codex/codex-event-mapper.ts
git commit -m "feat(codex): separate cached_input_tokens into cacheReadTokens field"
```

---

## Chunk 3: Server - RPC Handler and Broadcasting

### Task 9: Add `provider.getUsage` RPC handler

**Files:**
- Modify: `apps/server/src/transport/ws-router.ts:482-488`

- [ ] **Step 1: Add the RPC case after `provider.listModels` (line 488)**

```ts
case "provider.getUsage": {
  const provider = deps.providerRegistry.resolve(params.providerId);
  if (!provider.getUsage) {
    return { providerId: provider.id, quotaCategories: [] } satisfies ProviderUsageInfo;
  }
  return provider.getUsage();
}
```

- [ ] **Step 2: Verify server typechecks**

Run: `cd apps/server && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/transport/ws-router.ts
git commit -m "feat: add provider.getUsage RPC handler in ws-router"
```

---

## Chunk 4: Frontend - Store and Transport

### Task 10: Add `getProviderUsage` to transport layer

**Files:**
- Modify: `apps/web/src/transport/types.ts:236-238`
- Modify: `apps/web/src/transport/ws-transport.ts:451-453`

- [ ] **Step 1: Add to `McodeTransport` interface in `types.ts`**

After `listProviderModels`:

```ts
/** Fetch current usage/quota state for a provider. */
getProviderUsage(providerId: string): Promise<ProviderUsageInfo>;
```

Add the import:
```ts
import type { ProviderUsageInfo } from "@mcode/contracts/providers/usage.js";
```

- [ ] **Step 2: Implement in `ws-transport.ts`**

After `listProviderModels` implementation:

```ts
getProviderUsage: (providerId) =>
  rpc<ProviderUsageInfo>("provider.getUsage", { providerId }),
```

Add the import:
```ts
import type { ProviderUsageInfo } from "@mcode/contracts/providers/usage.js";
```

- [ ] **Step 3: Verify web typechecks**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/transport/types.ts apps/web/src/transport/ws-transport.ts
git commit -m "feat: add getProviderUsage to transport layer"
```

---

### Task 11: Extend `threadStore` with `usageByProvider` and new event handlers

**Files:**
- Modify: `apps/web/src/stores/threadStore.ts`

- [ ] **Step 1: Add `usageByProvider` to store state**

In the `ThreadState` interface (around line 62), add after `contextByThread`:

```ts
usageByProvider: Record<string, ProviderUsageInfo>;
```

Add the import:
```ts
import type { ProviderUsageInfo } from "@mcode/contracts/providers/usage.js";
```

In the initial state (around line 228), add after `contextByThread: {}`:

```ts
usageByProvider: {},
```

- [ ] **Step 2: Extend the `contextByThread` type**

Change the type at line 62 from:

```ts
contextByThread: Record<string, { lastTokensIn: number; contextWindow?: number; totalProcessedTokens?: number }>;
```

To:

```ts
contextByThread: Record<string, {
  lastTokensIn: number;
  contextWindow?: number;
  totalProcessedTokens?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMultiplier?: number;
}>;
```

- [ ] **Step 3: Update `session.turnComplete` handler to store new fields**

In the context update block (around lines 1235-1257), extend the `set` call:

```ts
set((state) => ({
  contextByThread: {
    ...state.contextByThread,
    [threadId]: {
      lastTokensIn: tokensIn,
      contextWindow,
      totalProcessedTokens,
      tokensOut: params.tokensOut as number | undefined,
      cacheReadTokens: params.cacheReadTokens as number | undefined,
      cacheWriteTokens: params.cacheWriteTokens as number | undefined,
      costMultiplier: params.costMultiplier as number | undefined,
    },
  },
}));
```

- [ ] **Step 4: Add `session.quotaUpdate` handler**

In `handleAgentEvent`, add a new case before the final return (after the existing `session.contextEstimate` case around line 1329):

```ts
if (method === "session.quotaUpdate") {
  const providerId = params.providerId as string;
  const categories = params.categories as QuotaCategory[];
  const sessionCostUsd = params.sessionCostUsd as number | undefined;
  if (providerId) {
    set((state) => ({
      usageByProvider: {
        ...state.usageByProvider,
        [providerId]: {
          providerId,
          quotaCategories: categories ?? [],
          sessionCostUsd: sessionCostUsd ?? state.usageByProvider[providerId]?.sessionCostUsd,
        },
      },
    }));
  }
  return;
}
```

Add the import:
```ts
import type { QuotaCategory } from "@mcode/contracts/providers/usage.js";
```

- [ ] **Step 5: Add `fetchProviderUsage` action**

Add a new action to the store for lazy hydration when popover opens:

```ts
fetchProviderUsage: async (providerId: string) => {
  try {
    const { getTransport } = await import("../transport/index.js");
    const usage = await getTransport().getProviderUsage(providerId);
    set((state) => ({
      usageByProvider: {
        ...state.usageByProvider,
        [providerId]: usage,
      },
    }));
  } catch {
    // Silently fail - popover shows stale or empty state
  }
},
```

- [ ] **Step 6: Verify web typechecks**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/stores/threadStore.ts
git commit -m "feat: add usageByProvider state and quotaUpdate handler to threadStore"
```

---

## Chunk 5: Frontend - UI Components

### Task 12: Create UsagePopover component

**Files:**
- Create: `apps/web/src/components/chat/UsagePopover.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/web/src/components/chat/UsagePopover.tsx
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useThreadStore } from "../../stores/threadStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { ProviderId } from "@mcode/contracts/providers/interfaces.js";
import type { QuotaCategory } from "@mcode/contracts/providers/usage.js";
import { useEffect, useRef, type ReactNode } from "react";

interface UsagePopoverProps {
  threadId: string | undefined;
  children: ReactNode;
}

/** Format token counts for display. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Days until a date, or undefined if no date. */
function daysUntil(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const diff = new Date(iso).getTime() - Date.now();
  return diff > 0 ? Math.ceil(diff / 86_400_000) : 0;
}

/** Progress bar component. */
function UsageBar({ percent, className }: { percent: number; className?: string }) {
  const color =
    percent >= 0.9 ? "bg-destructive" :
    percent >= 0.7 ? "bg-amber-500" :
    "bg-emerald-500";
  return (
    <div className="h-1 w-full rounded-full bg-muted">
      <div
        className={`h-1 rounded-full transition-all ${color} ${className ?? ""}`}
        style={{ width: `${Math.min(percent * 100, 100)}%` }}
      />
    </div>
  );
}

/** Single quota category row. */
function QuotaRow({ category }: { category: QuotaCategory }) {
  const usedDisplay = category.isUnlimited
    ? `${category.used}`
    : `${category.used} / ${category.total}`;
  const percent = category.isUnlimited ? 0 : (1 - category.remainingPercent);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{category.label}</span>
        <span className={percent >= 0.8 ? "text-destructive" : "text-foreground/70"}>
          {category.isUnlimited ? "unlimited" : usedDisplay}
        </span>
      </div>
      {!category.isUnlimited && <UsageBar percent={percent} />}
    </div>
  );
}

/** The usage popover content. */
export function UsagePopover({ threadId, children }: UsagePopoverProps) {
  const contextEntry = useThreadStore((s) => threadId ? s.contextByThread[threadId] : undefined);
  const activeThread = useWorkspaceStore((s) => s.threads.find((t) => t.id === threadId));
  const providerId = (activeThread?.provider ?? "claude") as ProviderId;
  const usageInfo = useThreadStore((s) => s.usageByProvider[providerId]);
  const fetchProviderUsage = useThreadStore((s) => s.fetchProviderUsage);
  const hasFetched = useRef(false);

  const handleOpenChange = (open: boolean) => {
    if (open && !hasFetched.current) {
      hasFetched.current = true;
      fetchProviderUsage(providerId);
    }
  };

  // Reset fetch flag when provider changes
  useEffect(() => {
    hasFetched.current = false;
  }, [providerId]);

  const categories = usageInfo?.quotaCategories ?? [];
  const sessionCost = usageInfo?.sessionCostUsd;
  const tokensIn = contextEntry?.lastTokensIn ?? 0;
  const contextWindow = contextEntry?.contextWindow;
  const hasContext = tokensIn > 0 && contextWindow;
  const hasTurn = tokensIn > 0;

  // Find earliest reset date across categories
  const resetDays = categories
    .map((c) => daysUntil(c.resetDate))
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b)[0];

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="space-y-3 p-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium capitalize">{providerId}</div>
              {activeThread?.model && (
                <div className="text-[10px] text-muted-foreground">
                  {activeThread.model}
                  {contextEntry?.costMultiplier != null && ` · ${contextEntry.costMultiplier}×`}
                </div>
              )}
            </div>
            {resetDays !== undefined && (
              <div className="text-right">
                <div className="text-[10px] text-muted-foreground">resets in</div>
                <div className="text-xs text-foreground/70">{resetDays}d</div>
              </div>
            )}
          </div>

          {/* Quota section */}
          {categories.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Quota
              </div>
              {categories.map((cat) => (
                <QuotaRow key={cat.label} category={cat} />
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Quota data not available for this provider
            </div>
          )}

          {/* Session cost (Claude) */}
          {sessionCost != null && (
            <div className="flex items-center justify-between border-t border-border pt-2 text-xs">
              <span className="text-muted-foreground">Session cost</span>
              <span className="text-foreground/70">${sessionCost.toFixed(4)}</span>
            </div>
          )}

          {/* Context window section */}
          {hasContext && (
            <div className="space-y-1 border-t border-border pt-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Context window
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Used</span>
                <span className="text-foreground/70">
                  {formatTokens(tokensIn)} / {formatTokens(contextWindow)}
                </span>
              </div>
              <UsageBar percent={tokensIn / contextWindow} />
            </div>
          )}

          {/* Last turn section */}
          {hasTurn ? (
            <div className="space-y-2 border-t border-border pt-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Last turn
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="rounded bg-muted/40 px-2 py-1.5">
                  <div className="text-[9px] text-muted-foreground">in</div>
                  <div className="text-xs text-foreground/80">{formatTokens(tokensIn)}</div>
                </div>
                <div className="rounded bg-muted/40 px-2 py-1.5">
                  <div className="text-[9px] text-muted-foreground">out</div>
                  <div className="text-xs text-foreground/80">
                    {formatTokens(contextEntry?.tokensOut ?? 0)}
                  </div>
                </div>
                {contextEntry?.cacheReadTokens != null && (
                  <div className="rounded bg-muted/40 px-2 py-1.5">
                    <div className="text-[9px] text-muted-foreground">cache read</div>
                    <div className="text-xs text-foreground/80">{formatTokens(contextEntry.cacheReadTokens)}</div>
                  </div>
                )}
                {contextEntry?.cacheWriteTokens != null && (
                  <div className="rounded bg-muted/40 px-2 py-1.5">
                    <div className="text-[9px] text-muted-foreground">cache write</div>
                    <div className="text-xs text-foreground/80">{formatTokens(contextEntry.cacheWriteTokens)}</div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="border-t border-border pt-2 text-xs text-muted-foreground">
              No turn data yet
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Verify web typechecks**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/chat/UsagePopover.tsx
git commit -m "feat: create UsagePopover component with quota, context, and turn sections"
```

---

### Task 13: Update ContextTracker - add click handler and low-quota badge

**Files:**
- Modify: `apps/web/src/components/chat/ContextTracker.tsx`

- [ ] **Step 1: Add `hasLowQuota` and `popoverOpen` props**

Update the props interface:

```ts
interface ContextTrackerProps {
  tokensIn: number;
  contextWindow?: number;
  totalProcessedTokens?: number;
  className?: string;
  hasLowQuota?: boolean;
  popoverOpen?: boolean;
}
```

Note: No `onClick` prop needed - `PopoverTrigger asChild` in `UsagePopover` automatically handles click events on this component.

- [ ] **Step 2: Add low-quota badge and cursor style**

Update the ring wrapper `<div>`:

```tsx
<div className={`relative cursor-pointer ${className ?? ""}`}>
  {/* existing SVG */}
  {hasLowQuota && (
    <div className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-background bg-destructive" />
  )}
</div>
```

- [ ] **Step 3: Suppress tooltip when popover is open**

The existing `Tooltip` wrapper should be suppressed when the popover is open. Update the `Tooltip` component to use controlled `open`:

```tsx
<Tooltip open={popoverOpen ? false : undefined}>
```

When `popoverOpen` is `true`, tooltip is forced closed. When `false` or `undefined`, tooltip behaves normally (uncontrolled).

- [ ] **Step 4: Verify web typechecks**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/ContextTracker.tsx
git commit -m "feat: add click handler and low-quota badge to ContextTracker"
```

---

### Task 14: Wire UsagePopover into Composer

**Files:**
- Modify: `apps/web/src/components/chat/Composer.tsx:1259-1266`

- [ ] **Step 1: Add imports**

```ts
import { UsagePopover } from "./UsagePopover";
```

- [ ] **Step 2: Add popover state**

Near the other state declarations:

```ts
const [usagePopoverOpen, setUsagePopoverOpen] = useState(false);
```

- [ ] **Step 3: Compute `hasLowQuota` and track popover state**

Place these near the other state and selector declarations in Composer, after the existing `contextEntry` selector:

```ts
const [usagePopoverOpen, setUsagePopoverOpen] = useState(false);
const activeProviderId = activeThread?.provider ?? "claude";
const usageInfo = useThreadStore((s) => s.usageByProvider[activeProviderId]);
const hasLowQuota = usageInfo?.quotaCategories.some((c) => !c.isUnlimited && c.remainingPercent < 0.2) ?? false;
```

- [ ] **Step 4: Add `onOpenChange` prop to UsagePopover**

In `UsagePopover.tsx`, add an `onOpenChange` callback prop:

```ts
interface UsagePopoverProps {
  threadId: string | undefined;
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}
```

Wire it into the `Popover`:

```tsx
<Popover onOpenChange={(open) => { handleOpenChange(open); onOpenChange?.(open); }}>
```

- [ ] **Step 5: Wrap ContextTracker with UsagePopover**

Replace the existing ContextTracker render (lines 1259-1266):

```tsx
{threadId && (
  <UsagePopover threadId={threadId} onOpenChange={setUsagePopoverOpen}>
    <ContextTracker
      tokensIn={contextEntry?.lastTokensIn ?? activeThread?.last_context_tokens ?? 0}
      contextWindow={contextEntry?.contextWindow ?? activeThread?.context_window ?? undefined}
      totalProcessedTokens={contextEntry?.totalProcessedTokens}
      hasLowQuota={hasLowQuota}
      popoverOpen={usagePopoverOpen}
    />
  </UsagePopover>
)}
```

- [ ] **Step 5: Verify web typechecks**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Run full typecheck across all packages**

```bash
(cd packages/contracts && npx tsc --noEmit) && \
(cd apps/server && npx tsc --noEmit) && \
(cd apps/web && npx tsc --noEmit)
```

Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/chat/Composer.tsx
git commit -m "feat: wire UsagePopover into Composer around ContextTracker"
```

---

### Task 15: Manual verification

- [ ] **Step 1: Run dev server**

```bash
bun run dev
```

- [ ] **Step 2: Test with Copilot provider**

1. Open the app, select Copilot provider
2. Send a message
3. Click the context ring - popover should show quota categories, context window, and last turn tokens
4. Verify the ring shows a red dot if quota is below 20%

- [ ] **Step 3: Test with Claude provider**

1. Switch to Claude provider
2. Send a message
3. Click the ring - popover should show session cost, context window, and last turn tokens
4. Quota section should show "Quota data not available for this provider"

- [ ] **Step 4: Test with Codex provider**

1. Switch to Codex provider
2. Send a message
3. Click the ring - popover should show last turn tokens only
4. Context window section should be hidden

- [ ] **Step 5: Test edge cases**

1. Open popover before sending any message - shows "No turn data yet"
2. Dismiss and reopen popover - should still show cached data
3. Switch providers while popover is open - popover content should update

- [ ] **Step 6: Final commit (if any fixes needed)**

Stage only the specific files that were fixed during verification and commit.
