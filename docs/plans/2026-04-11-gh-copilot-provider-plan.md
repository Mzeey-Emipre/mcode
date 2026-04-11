# GitHub Copilot Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub Copilot as a third AI provider, wrapping `@github/copilot-sdk` with full event mapping, 17-model registry, and UX fixes for large model lists.

**Architecture:** Fork the Codex provider pattern (client + session model). Copilot SDK uses callback-based events instead of async iterators, so `runTurn()` registers handlers before calling `session.send()` and resolves on `session.idle`. All other patterns (session map, idle eviction, abort, resume) carry over directly.

**Tech Stack:** `@github/copilot-sdk`, tsyringe DI, Zod schemas, React + base-ui Select component

---

### Task 1: Install SDK Dependency

**Files:**
- Modify: `apps/server/package.json`

- [ ] **Step 1: Add the dependency**

```bash
cd apps/server && bun add @github/copilot-sdk
```

- [ ] **Step 2: Verify installation**

```bash
cd apps/server && node -e "require('@github/copilot-sdk')"
```

Expected: No error output.

- [ ] **Step 3: Commit**

```bash
git add apps/server/package.json apps/server/bun.lock
git commit -m "chore: add @github/copilot-sdk dependency"
```

Note: If there is a root-level `bun.lock` or `bun.lockb` instead, stage that file.

---

### Task 2: Settings Schema

**Files:**
- Modify: `packages/contracts/src/models/settings.ts:144-151` (SettingsSchema provider.cli)
- Modify: `packages/contracts/src/models/settings.ts:237-246` (PartialSettingsSchema provider.cli)

- [ ] **Step 1: Add copilot to SettingsSchema**

In `packages/contracts/src/models/settings.ts`, inside the `cli` object (around line 144-151), add the copilot field after the claude field:

```typescript
        cli: z
          .object({
            /** Path to the Codex CLI binary. Empty uses PATH lookup. */
            codex: z.string().default(""),
            /** Path to the Claude CLI binary. Empty uses PATH lookup. */
            claude: z.string().default(""),
            /** Path to the Copilot CLI binary. Empty uses PATH lookup. */
            copilot: z.string().default(""),
          })
          .default({}),
```

- [ ] **Step 2: Add copilot to PartialSettingsSchema**

In the same file, inside the partial `cli` object (around line 237-246):

```typescript
      provider: z
        .object({
          cli: z
            .object({
              codex: z.string().optional(),
              claude: z.string().optional(),
              copilot: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
```

- [ ] **Step 3: Typecheck contracts**

```bash
cd packages/contracts && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/models/settings.ts
git commit -m "feat: add copilot CLI path to settings schema"
```

---

### Task 3: CopilotProvider

**Files:**
- Create: `apps/server/src/providers/copilot/copilot-provider.ts`

Fork from `apps/server/src/providers/codex/codex-provider.ts`. The key structural change is replacing the async-iterator event loop with callback-based event handlers.

- [ ] **Step 1: Create the provider file**

Create `apps/server/src/providers/copilot/copilot-provider.ts` with the following content:

```typescript
/**
 * GitHub Copilot SDK provider adapter.
 * Implements IAgentProvider using @github/copilot-sdk with callback-based event mapping.
 *
 * SDK event model:
 *   session.start -> assistant.turn_start -> assistant.message_delta/tool.* -> assistant.turn_end -> session.idle
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { injectable, inject } from "tsyringe";
import { SettingsService } from "../../services/settings-service";
import { EventEmitter } from "events";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession } from "@github/copilot-sdk";
import { logger } from "@mcode/shared";
import type {
  IAgentProvider,
  ProviderId,
  ReasoningLevel,
  AgentEvent,
  AttachmentMeta,
} from "@mcode/contracts";

const execFileAsync = promisify(execFile);

/** Idle TTL before a session is evicted (10 minutes). */
const IDLE_TTL_MS = 10 * 60 * 1000;
/** How often to check for idle sessions (1 minute). */
const EVICTION_INTERVAL_MS = 60 * 1000;

interface SessionEntry {
  session: CopilotSession;
  lastUsedAt: number;
}

/** GitHub Copilot SDK adapter implementing IAgentProvider with streaming events. */
@injectable()
export class CopilotProvider extends EventEmitter implements IAgentProvider {
  readonly id: ProviderId = "copilot";

  private client: CopilotClient | null = null;
  private lastCliPath: string | undefined;
  private sessions = new Map<string, SessionEntry>();
  private sdkSessionIds = new Map<string, string>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
  ) {
    super();
  }

  /**
   * Check whether the Copilot CLI binary is reachable.
   * Returns an error message if unavailable, or null if found.
   */
  private async checkCliAvailable(): Promise<string | null> {
    const settings = await this.settingsService.get();
    const cliPath = settings.provider.cli.copilot || "copilot";

    try {
      await execFileAsync(cliPath, ["--version"], { timeout: 5000, shell: true });
      return null;
    } catch {
      if (cliPath === "copilot") {
        return "Copilot CLI not found. Install it with: npm install -g @github/copilot\n\nOr set a custom path in Settings > Provider > Copilot CLI path.";
      }
      return `Copilot CLI not found at "${cliPath}". Check the path in Settings > Provider > Copilot CLI path.`;
    }
  }

  /**
   * Rebuild the CopilotClient when the CLI path setting changes.
   * Only recreates if the path actually differs.
   */
  private async refreshClient(): Promise<CopilotClient> {
    const settings = await this.settingsService.get();
    const cliPath = settings.provider.cli.copilot || undefined;

    if (this.client && cliPath === this.lastCliPath) return this.client;

    if (this.client) {
      try { await this.client.stop(); } catch { /* best-effort */ }
    }

    this.lastCliPath = cliPath;
    this.client = new CopilotClient({
      ...(cliPath && { cliPath }),
      useLoggedInUser: true,
    });
    await this.client.start();
    return this.client;
  }

  /** Start or continue a session by sending a message via the Copilot SDK. */
  async sendMessage(params: {
    sessionId: string;
    message: string;
    cwd: string;
    model: string;
    fallbackModel?: string;
    resume: boolean;
    permissionMode: string;
    attachments?: AttachmentMeta[];
    reasoningLevel?: ReasoningLevel;
  }): Promise<void> {
    try {
      await this.doSendMessage(params);
    } catch (e: unknown) {
      logger.error("CopilotProvider sendMessage error", {
        sessionId: params.sessionId,
        error: String(e),
      });
      throw e;
    }
  }

  private async doSendMessage(params: {
    sessionId: string;
    message: string;
    cwd: string;
    model: string;
    fallbackModel?: string;
    resume: boolean;
    permissionMode: string;
    attachments?: AttachmentMeta[];
    reasoningLevel?: ReasoningLevel;
  }): Promise<void> {
    const client = await this.refreshClient();

    const { sessionId, message, cwd, model, resume } = params;

    if (!this.evictionTimer) {
      this.evictionTimer = setInterval(
        () => this.evictIdleSessions(),
        EVICTION_INTERVAL_MS,
      );
    }

    const threadId = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;

    const existing = this.sessions.get(sessionId);

    if (existing) {
      existing.lastUsedAt = Date.now();
      void this.runTurn(sessionId, threadId, existing.session, message);
      return;
    }

    // Probe CLI availability only when starting a new session
    const cliError = await this.checkCliAvailable();
    if (cliError) {
      this.emit("event", {
        type: "error",
        threadId,
        error: cliError,
      } satisfies AgentEvent);
      this.emit("event", {
        type: "ended",
        threadId,
      } satisfies AgentEvent);
      return;
    }

    let session: CopilotSession;
    const resumeId = this.sdkSessionIds.get(sessionId);

    if (resume && resumeId) {
      try {
        session = await client.resumeSession(resumeId, {
          onPermissionRequest: approveAll,
        });
        logger.info("Resumed Copilot session", { sessionId, resumeId });
      } catch (err) {
        logger.warn("Copilot resume failed, starting fresh session", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.sdkSessionIds.delete(sessionId);
        session = await client.createSession({
          model: model || undefined,
          workingDirectory: cwd,
          onPermissionRequest: approveAll,
          streaming: true,
        });
      }
    } else {
      session = await client.createSession({
        model: model || undefined,
        workingDirectory: cwd,
        onPermissionRequest: approveAll,
        streaming: true,
      });
    }

    // Capture SDK session ID for resume
    const sdkId = session.id;
    if (sdkId) {
      this.sdkSessionIds.set(sessionId, sdkId);
      this.emit("event", {
        type: "system",
        threadId,
        subtype: "sdk_session_id:" + sdkId,
      } satisfies AgentEvent);
    }

    const entry: SessionEntry = {
      session,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(sessionId, entry);

    void this.runTurn(sessionId, threadId, session, message);
  }

  /**
   * Execute a single turn by registering event handlers and calling session.send().
   * Resolves when the session emits `session.idle` or an error occurs.
   */
  private async runTurn(
    sessionId: string,
    threadId: string,
    session: CopilotSession,
    message: string,
  ): Promise<void> {
    let lastAssistantText = "";

    // Wrap the callback-based event stream in a promise that resolves on idle
    const turnPromise = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        session.off("assistant.message_delta", onDelta);
        session.off("assistant.message", onMessage);
        session.off("tool.execution_start", onToolStart);
        session.off("tool.execution_complete", onToolComplete);
        session.off("tool.execution_progress", onToolProgress);
        session.off("assistant.turn_end", onTurnEnd);
        session.off("assistant.usage", onUsage);
        session.off("session.error", onError);
        session.off("session.idle", onIdle);
        session.off("session.compaction_start", onCompactStart);
        session.off("session.compaction_complete", onCompactComplete);
      };

      const onDelta = (data: { deltaContent: string }) => {
        const entry = this.sessions.get(sessionId);
        if (entry) entry.lastUsedAt = Date.now();

        if (data.deltaContent) {
          lastAssistantText += data.deltaContent;
          this.emit("event", {
            type: "textDelta",
            threadId,
            delta: data.deltaContent,
          } satisfies AgentEvent);
        }
      };

      const onMessage = (data: { content: string }) => {
        lastAssistantText = data.content;
        this.emit("event", {
          type: "message",
          threadId,
          content: data.content,
          tokens: null,
        } satisfies AgentEvent);
      };

      const onToolStart = (data: { toolCallId: string; toolName: string; arguments: Record<string, unknown> }) => {
        const entry = this.sessions.get(sessionId);
        if (entry) entry.lastUsedAt = Date.now();

        this.emit("event", {
          type: "toolUse",
          threadId,
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          toolInput: data.arguments ?? {},
        } satisfies AgentEvent);
      };

      const onToolComplete = (data: { toolCallId: string; toolName: string; success: boolean; result?: string; error?: string }) => {
        this.emit("event", {
          type: "toolResult",
          threadId,
          toolCallId: data.toolCallId,
          output: data.error ?? data.result ?? "",
          isError: !data.success,
        } satisfies AgentEvent);
      };

      const onToolProgress = () => {
        this.emit("event", {
          type: "toolProgress",
          threadId,
        } satisfies AgentEvent);
      };

      let turnTokensIn = 0;
      let turnTokensOut = 0;

      const onTurnEnd = () => {
        // Full message already emitted via onMessage
      };

      const onUsage = (data: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number }) => {
        turnTokensIn = (data.input_tokens ?? 0) + (data.cached_input_tokens ?? 0);
        turnTokensOut = data.output_tokens ?? 0;

        this.emit("event", {
          type: "turnComplete",
          threadId,
          reason: "end_turn",
          costUsd: null,
          tokensIn: turnTokensIn,
          tokensOut: turnTokensOut,
          contextWindow: undefined,
          totalProcessedTokens: turnTokensIn + turnTokensOut,
        } satisfies AgentEvent);
      };

      const onError = (data: { message: string }) => {
        this.emit("event", {
          type: "error",
          threadId,
          error: data.message,
        } satisfies AgentEvent);
      };

      const onIdle = () => {
        cleanup();
        resolve();
      };

      const onCompactStart = () => {
        this.emit("event", {
          type: "compacting",
          threadId,
          phase: "started",
        } satisfies AgentEvent);
      };

      const onCompactComplete = (data: { summary?: string }) => {
        if (data.summary) {
          this.emit("event", {
            type: "compactSummary",
            threadId,
            summary: data.summary,
          } satisfies AgentEvent);
        }
        this.emit("event", {
          type: "compacting",
          threadId,
          phase: "completed",
        } satisfies AgentEvent);
      };

      session.on("assistant.message_delta", onDelta);
      session.on("assistant.message", onMessage);
      session.on("tool.execution_start", onToolStart);
      session.on("tool.execution_complete", onToolComplete);
      session.on("tool.execution_progress", onToolProgress);
      session.on("assistant.turn_end", onTurnEnd);
      session.on("assistant.usage", onUsage);
      session.on("session.error", onError);
      session.on("session.idle", onIdle);
      session.on("session.compaction_start", onCompactStart);
      session.on("session.compaction_complete", onCompactComplete);
    });

    try {
      await session.send({ prompt: message });
      await turnPromise;
    } catch (e: unknown) {
      if ((e as { name?: string }).name === "AbortError") {
        logger.info("Copilot turn aborted", { sessionId });
      } else {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logger.error("Copilot stream error", { sessionId, error: errorMessage });
        this.emit("event", {
          type: "error",
          threadId,
          error: errorMessage,
        } satisfies AgentEvent);
      }
    } finally {
      this.emit("event", {
        type: "ended",
        threadId,
      } satisfies AgentEvent);
    }
  }

  /** Evict sessions that have been idle longer than IDLE_TTL_MS. */
  private evictIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastUsedAt > IDLE_TTL_MS) {
        logger.info("Evicting idle Copilot session", { sessionId });
        try { void entry.session.disconnect(); } catch { /* best-effort */ }
        this.sessions.delete(sessionId);
      }
    }
  }

  /** Pre-load an SDK session ID mapping (e.g. from the database on startup). */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    this.sdkSessionIds.set(sessionId, sdkSessionId);
  }

  /** Abort a running session. */
  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      try { void entry.session.abort(); } catch { /* best-effort */ }
      this.sessions.delete(sessionId);
    }
  }

  /** Tear down all sessions and release resources. */
  shutdown(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    for (const [, entry] of this.sessions) {
      try { void entry.session.disconnect(); } catch { /* best-effort */ }
    }
    this.sessions.clear();
    this.sdkSessionIds.clear();
    if (this.client) {
      try { void this.client.stop(); } catch { /* best-effort */ }
      this.client = null;
    }
    logger.info("CopilotProvider shutdown complete");
  }
}
```

- [ ] **Step 2: Typecheck server**

```bash
cd apps/server && npx tsc --noEmit
```

Expected: No errors. If there are type mismatches with the SDK's actual exports (e.g. `CopilotSession` might be named differently, `session.on` event names might differ), adjust the imports and handler types based on the actual SDK type definitions. Run `node -e "console.log(Object.keys(require('@github/copilot-sdk')))"` to inspect exports if needed.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/providers/copilot/copilot-provider.ts
git commit -m "feat: add CopilotProvider implementing IAgentProvider"
```

---

### Task 4: DI Registration

**Files:**
- Modify: `apps/server/src/container.ts:20-24` (imports), `apps/server/src/container.ts:108-124` (provider registrations)

- [ ] **Step 1: Add import**

In `apps/server/src/container.ts`, add the import after the CodexProvider import (line 22):

```typescript
import { CopilotProvider } from "./providers/copilot/copilot-provider";
```

- [ ] **Step 2: Register provider**

After the CodexProvider registration block (after line 124), add:

```typescript
  container.register(
    CopilotProvider,
    { useClass: CopilotProvider },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IAgentProvider", {
    useFactory: (c) => c.resolve(CopilotProvider),
  });
```

- [ ] **Step 3: Typecheck server**

```bash
cd apps/server && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/container.ts
git commit -m "feat: register CopilotProvider in DI container"
```

---

### Task 5: Error Normalization

**Files:**
- Modify: `apps/server/src/services/agent-service.ts:880-897`

- [ ] **Step 1: Add copilot case**

In `apps/server/src/services/agent-service.ts`, inside the `normalizeProviderError` method, add a copilot case after the codex case:

```typescript
      if (provider === "copilot") {
        return "Copilot CLI not found. Install it with: npm install -g @github/copilot\n\nOr set a custom path in Settings > Provider > Copilot CLI path.";
      }
```

The method should now look like:

```typescript
  private normalizeProviderError(message: string, provider: string): string {
    if (message.includes("ENOENT") || message.includes("spawn") && message.includes("ENOENT")) {
      if (provider === "claude") {
        return "Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code\n\nOr set a custom path in Settings > Model.";
      }
      if (provider === "codex") {
        return "Codex CLI not found. Install it with: npm install -g @openai/codex\n\nOr set a custom path in Settings > Model.";
      }
      if (provider === "copilot") {
        return "Copilot CLI not found. Install it with: npm install -g @github/copilot\n\nOr set a custom path in Settings > Provider > Copilot CLI path.";
      }
      return `${provider} CLI not found. Check the CLI path in Settings > Model.`;
    }
    return message;
  }
```

- [ ] **Step 2: Typecheck server**

```bash
cd apps/server && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/services/agent-service.ts
git commit -m "feat: add copilot to normalizeProviderError"
```

---

### Task 6: Model Registry

**Files:**
- Modify: `apps/web/src/lib/model-registry.ts:33-106`

- [ ] **Step 1: Add copilot provider entry**

In `apps/web/src/lib/model-registry.ts`, add the copilot provider entry in the `MODEL_PROVIDERS` array. Place it after the codex entry (after line 87) and before the coming-soon providers:

```typescript
  {
    id: "copilot",
    name: "GitHub Copilot",
    comingSoon: false,
    models: [
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", providerId: "copilot" },
      { id: "gpt-5.2-codex", label: "GPT-5.2 Codex", providerId: "copilot" },
      { id: "gpt-5.2", label: "GPT-5.2", providerId: "copilot" },
      { id: "gpt-5.1-codex", label: "GPT-5.1 Codex", providerId: "copilot" },
      { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max", providerId: "copilot" },
      { id: "gpt-5.1", label: "GPT-5.1", providerId: "copilot" },
      { id: "gpt-5-mini", label: "GPT-5 mini", providerId: "copilot" },
      { id: "gpt-4.1", label: "GPT-4.1", providerId: "copilot" },
      { id: "claude-opus-4.6", label: "Claude Opus 4.6", providerId: "copilot" },
      { id: "claude-opus-4-6-fast", label: "Claude Opus 4.6 Fast", providerId: "copilot" },
      { id: "claude-opus-4.5", label: "Claude Opus 4.5", providerId: "copilot" },
      { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6", providerId: "copilot" },
      { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", providerId: "copilot" },
      { id: "claude-haiku-4.5", label: "Claude Haiku 4.5", providerId: "copilot" },
      { id: "gemini-3-pro", label: "Gemini 3 Pro", providerId: "copilot" },
      { id: "gemini-3-flash", label: "Gemini 3 Flash", providerId: "copilot" },
      { id: "grok-code-fast-1", label: "Grok Code Fast 1", providerId: "copilot" },
    ],
  },
```

- [ ] **Step 2: Typecheck web**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/model-registry.ts
git commit -m "feat: add copilot provider with 17 models to registry"
```

---

### Task 7: Provider Icon

**Files:**
- Modify: `apps/web/src/components/chat/ProviderIcons.tsx`

- [ ] **Step 1: Add CopilotIcon component**

Append to `apps/web/src/components/chat/ProviderIcons.tsx` before the closing of the file (after line 109):

```typescript
/** GitHub Copilot - official Copilot dual-sparkle logomark. */
export function CopilotIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9.106 2.853a4.9 4.9 0 0 1 5.788 0l3.834 2.791A4.88 4.88 0 0 1 20.7 9.727v2.456a1 1 0 0 1-.27.685l-2.07 2.22v3.56a1 1 0 0 1-.465.845l-5.437 3.43a1 1 0 0 1-1.07-.01l-5.186-3.39a1 1 0 0 1-.452-.838v-3.597l-2.07-2.22a1 1 0 0 1-.27-.685V9.727a4.88 4.88 0 0 1 1.972-3.942zM8.75 13.667l-2.34-2.51V9.727a2.88 2.88 0 0 1 1.163-2.325l3.834-2.791a2.9 2.9 0 0 1 3.425-.062l.017.012.018.013 3.834 2.791a2.88 2.88 0 0 1 1.189 2.362v1.43l-2.34 2.51v3.17l-4.5 2.839-4.3-2.812zM10 10.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m5.5 1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3"
        fill="currentColor"
      />
    </svg>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/chat/ProviderIcons.tsx
git commit -m "feat: add CopilotIcon provider brand icon"
```

---

### Task 8: ModelSelector UX (Composer)

**Files:**
- Modify: `apps/web/src/components/chat/ModelSelector.tsx:1-28` (imports, PROVIDER_META)
- Modify: `apps/web/src/components/chat/ModelSelector.tsx:101-124` (submenu scroll fix)

- [ ] **Step 1: Add CopilotIcon import**

In `apps/web/src/components/chat/ModelSelector.tsx`, add `CopilotIcon` to the import from `./ProviderIcons` (line 18):

```typescript
import {
  ClaudeIcon,
  CodexIcon,
  CursorProviderIcon,
  OpenCodeIcon,
  GeminiIcon,
  CopilotIcon,
} from "./ProviderIcons";
```

- [ ] **Step 2: Add copilot to PROVIDER_META**

Add the copilot entry to the `PROVIDER_META` object (after line 27):

```typescript
const PROVIDER_META: Record<string, { icon: IconComponent; color: string }> = {
  claude: { icon: ClaudeIcon, color: "text-orange-500 dark:text-orange-400" },
  codex: { icon: CodexIcon, color: "text-emerald-400" },
  copilot: { icon: CopilotIcon, color: "text-sky-400" },
  cursor: { icon: CursorProviderIcon, color: "text-blue-400" },
  opencode: { icon: OpenCodeIcon, color: "text-violet-400" },
  gemini: { icon: GeminiIcon, color: "text-sky-400" },
};
```

- [ ] **Step 3: Add scroll to submenu**

In the `renderSubmenu` function (line 107), add `max-h-[280px] overflow-y-auto` to the inner container div:

Change:
```typescript
      <div className="rounded-md border border-border bg-popover p-1 shadow-lg">
```

To:
```typescript
      <div className="max-h-[280px] overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg">
```

- [ ] **Step 4: Add scroll to provider-locked model list**

The provider-locked view (lines 137-151) also renders all models in a flat list. Wrap it with the same scroll constraint. Change the `{providerLocked && provider ? (` block to:

```typescript
          {providerLocked && provider ? (
            <div className="max-h-[280px] overflow-y-auto">
            {provider.models.map((m) => (
              <button
                key={m.id}
                onClick={() => handleSelectModel(m.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs",
                  m.id === normalizedSelectedId
                    ? "bg-accent text-foreground"
                    : "text-popover-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                {m.label}
              </button>
            ))}
            </div>
```

- [ ] **Step 5: Typecheck web**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/chat/ModelSelector.tsx
git commit -m "feat: add copilot to model selector with scroll fix for large lists"
```

---

### Task 9: Settings ModelSection UX

**Files:**
- Modify: `apps/web/src/components/settings/sections/ModelSection.tsx`

This task adds the Copilot icon, CLI path input, and replaces `SegControl` with a `Select` dropdown for providers with more than 6 models.

- [ ] **Step 1: Add imports**

Add the CopilotIcon import and the Select component imports at the top of `ModelSection.tsx`:

```typescript
import {
  ClaudeIcon,
  CodexIcon,
  CursorProviderIcon,
  OpenCodeIcon,
  GeminiIcon,
  CopilotIcon,
} from "@/components/chat/ProviderIcons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
```

- [ ] **Step 2: Add copilot to PROVIDER_ICONS**

Add the copilot entry to the `PROVIDER_ICONS` object (after line 28):

```typescript
const PROVIDER_ICONS: Record<string, ReactNode> = {
  claude: <ClaudeIcon size={12} />,
  codex: <CodexIcon size={12} />,
  copilot: <CopilotIcon size={12} />,
  cursor: <CursorProviderIcon size={12} />,
  opencode: <OpenCodeIcon size={12} />,
  gemini: <GeminiIcon size={12} />,
};
```

- [ ] **Step 3: Read copilot CLI path from settings store**

In the `ModelSection` component, add the copilot CLI path state alongside the existing ones (after line 67):

```typescript
  const copilotCliPath = useSettingsStore((s) => s.settings.provider.cli.copilot);
```

- [ ] **Step 4: Add threshold constant and conditional model selector**

Add a threshold constant above the `ModelSection` component:

```typescript
/** Providers with more models than this threshold use a Select dropdown instead of SegControl. */
const SEG_CONTROL_MAX_MODELS = 6;
```

Then replace the "Default model" `SettingRow` (lines 165-171) with a conditional render:

```typescript
      <SettingRow
        label="Default model"
        configKey="model.defaults.id"
        hint="New threads start with this model."
      >
        {modelOptions.length > SEG_CONTROL_MAX_MODELS ? (
          <Select value={modelId} onValueChange={handleModelChange}>
            <SelectTrigger size="sm" className="w-56 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <SegControl options={modelOptions} value={modelId} onChange={handleModelChange} />
        )}
      </SettingRow>
```

- [ ] **Step 5: Apply same pattern to fallback model selector**

Replace the "Fallback model" `SettingRow` (lines 173-183) with:

```typescript
      <SettingRow
        label="Fallback model"
        configKey="model.defaults.fallbackId"
        hint="Used when the primary model is unavailable. Off disables fallback."
      >
        {fallbackOptions.length > SEG_CONTROL_MAX_MODELS ? (
          <Select
            value={fallbackId}
            onValueChange={(v) => update({ model: { defaults: { fallbackId: v } } })}
          >
            <SelectTrigger size="sm" className="w-56 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fallbackOptions.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <SegControl
            options={fallbackOptions}
            value={fallbackId}
            onChange={(v) => update({ model: { defaults: { fallbackId: v } } })}
          />
        )}
      </SettingRow>
```

- [ ] **Step 6: Add Copilot CLI path input**

After the Claude CLI path `SettingRow` (after line 226), add:

```typescript
          <SettingRow
            label="Copilot CLI path"
            configKey="provider.cli.copilot"
            hint="Path to the Copilot CLI binary. Leave empty to auto-discover from PATH."
          >
            <Input
              value={copilotCliPath}
              onChange={(e) => void update({ provider: { cli: { copilot: e.target.value } } })}
              placeholder="copilot"
              className="h-7 w-56 text-xs"
            />
          </SettingRow>
```

- [ ] **Step 7: Typecheck web**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/settings/sections/ModelSection.tsx
git commit -m "feat: copilot settings UI with Select dropdown for large model lists"
```

---

### Task 10: Cross-Package Typecheck and Verification

**Files:** None (verification only)

- [ ] **Step 1: Typecheck all packages**

```bash
cd packages/contracts && npx tsc --noEmit
cd apps/server && npx tsc --noEmit
cd apps/web && npx tsc --noEmit
cd apps/desktop && npx tsc --noEmit
```

Expected: All four pass with no errors.

- [ ] **Step 2: Run unit tests**

```bash
bun run test
```

Expected: All tests pass.

- [ ] **Step 3: Verify dev server starts**

```bash
bun run dev:web
```

Expected: Vite dev server starts. Open the app, go to Settings > Model, verify:
- "GitHub Copilot" appears in the provider selector
- Selecting it shows a dropdown (not segmented buttons) with 17 models
- Copilot CLI path input appears in CLI Paths section

- [ ] **Step 4: Verify composer model selector**

Open the composer, click the model selector:
- "GitHub Copilot" appears with the Copilot icon
- Hovering shows a scrollable submenu with 17 models
- Selecting a model works

- [ ] **Step 5: Commit any fixes**

If any adjustments were needed:

```bash
git add -A
git commit -m "fix: address typecheck and UI issues from copilot integration"
```
