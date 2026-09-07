import { z } from "zod";
import { InteractionModeSchema, PermissionModeSchema } from "./enums.js";
import { lazySchema } from "../utils/lazySchema.js";
import {
  TERMINAL_SETTINGS_SCHEMA_VERSION,
  TerminalAccessibilitySettingsSchema,
  TerminalBehaviorSettingsSchema,
  TerminalPresentationSettingsSchema,
  TerminalSettingsSchema,
  getDefaultTerminalSettingsDocument,
} from "./terminal-settings.js";

// ---------------------------------------------------------------------------
// Enum schemas
// ---------------------------------------------------------------------------

/** UI theme preference. */
export const ThemeSchema = z.enum(["system", "dark", "light"]);
/** UI theme preference value. */
export type Theme = z.infer<typeof ThemeSchema>;

/**
 * Default agent interaction mode.
 *
 * Extends the base InteractionMode with an "agent" option that grants
 * autonomous multi-step execution capabilities.
 *
 * Accepts legacy `"chat"` from pre-rename settings files and normalizes it to `"build"`.
 */
export const AgentDefaultModeSchema = z
  .enum([...InteractionModeSchema.options, "agent", "chat"])
  .transform((mode) => (mode === "chat" ? "build" : mode));
/** Default agent interaction mode value. */
export type AgentDefaultMode = z.infer<typeof AgentDefaultModeSchema>;

/**
 * Reasoning effort level for model inference.
 * "max" maps to extended reasoning in Claude and Codex; "xhigh" maps to Codex's xhigh effort tier and Claude Opus 4.7+.
 * "none" and "minimal" map to OpenAI Codex `effort` presets; Claude models normalize them to "low".
 * Legacy orchestration-shaped values normalize to "max" when older settings are loaded.
 */
export const ReasoningLevelSchema = z.preprocess(
  (value) => value === "ultra" || value === "ultrathink" ? "max" : value,
  z.enum(["none", "minimal", "low", "medium", "high", "max", "xhigh"]),
);
/** Reasoning effort level value. */
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/**
 * Context window selection for Claude models that support an extended 1M tier.
 * "200k" is the default tier every Claude model supports; "1m" requests the
 * 1,000,000-token tier (only honored for Opus 4.7/4.6 and Sonnet 4.6).
 *
 * At send time the server appends a `[1m]` suffix to the model slug to opt
 * into the extended window via the Claude Agent SDK; the SDK forwards the
 * appropriate beta header internally.
 */
export const ContextWindowModeSchema = z.enum(["200k", "1m"]);
/** Context window selection value. */
export type ContextWindowMode = z.infer<typeof ContextWindowModeSchema>;

/** Supported AI provider identifier for settings. */
export const ProviderIdSchema = z.enum(["claude", "codex", "gemini", "copilot", "cursor", "opencode"]);
/** Supported AI provider identifier value. */
export type SettingsProviderId = z.infer<typeof ProviderIdSchema>;

/** Worktree branch naming strategy. */
export const NamingModeSchema = z.enum(["auto", "custom", "ai"]);
/** Worktree branch naming strategy value. */
export type NamingMode = z.infer<typeof NamingModeSchema>;

/** Auto-update check interval. */
export const UpdateCheckIntervalSchema = z.enum(["15min", "1hour", "4hours", "1day", "never"]);
/** Auto-update check interval value. */
export type UpdateCheckInterval = z.infer<typeof UpdateCheckIntervalSchema>;

/**
 * Desktop auto-update release line. Maps to electron-updater publish channel:
 * `stable` uses the default `latest` feed; `nightly` uses the `nightly` channel
 * (prerelease artifacts from CI).
 */
export const UpdateReleaseLineSchema = z.enum(["stable", "nightly"]);
/** Desktop auto-update release line value. */
export type UpdateReleaseLine = z.infer<typeof UpdateReleaseLineSchema>;

/** Days to retain completed threads, or null when automatic deletion is disabled. */
export const CompletedThreadRetentionDaysSchema = z.number().int().min(1).max(365).nullable();
/** Completed-thread retention value. */
export type CompletedThreadRetentionDays = z.infer<typeof CompletedThreadRetentionDaysSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default grace-period seconds before the server auto-shuts down after all
 * sessions disconnect. Shared between the schema default and the
 * mode-aware resolver in `grace-period-ms.ts`.
 */
export const GRACE_PERIOD_DEFAULT_SECONDS = 30;

/** Default server memory budget for the desktop-managed process, in MiB. */
export const SERVER_HEAP_DEFAULT_MB = 512;

/** Lowest supported server memory budget for the server process, in MiB. */
export const SERVER_HEAP_MIN_MB = 256;

/** Highest supported server memory budget for the server process, in MiB. */
export const SERVER_HEAP_MAX_MB = 8192;

/** Shipped default from older installs, migrated to {@link SERVER_HEAP_DEFAULT_MB}. */
export const SERVER_HEAP_LEGACY_DEFAULT_MB = 96;

const CursorUsageEmailSchema = z
  .string()
  .trim()
  .max(320)
  .refine((value) => value === "" || z.string().email().safeParse(value).success, {
    message: "Must be empty or a valid email address",
  });

// ---------------------------------------------------------------------------
// Settings schema
// ---------------------------------------------------------------------------

/** Schema for the full user settings object. Every field has a default. */
export const SettingsSchema = lazySchema(() =>
  z.object({
    /** Persisted settings document metadata. */
    meta: z
      .object({
        /** Current settings document schema version. */
        schemaVersion: z.literal(TERMINAL_SETTINGS_SCHEMA_VERSION),
      })
      .strict()
      .default({ schemaVersion: TERMINAL_SETTINGS_SCHEMA_VERSION }),
    /** Visual appearance settings. */
    appearance: z
      .object({
        /** Color theme preference. */
        theme: ThemeSchema.default("system"),
      })
      .default({}),

    /** Agent orchestration settings. */
    agent: z
      .object({
        /** Maximum number of concurrent agent sessions. */
        maxConcurrent: z.number().int().positive().default(5),
        /** Default values for new agent sessions. */
        defaults: z
          .object({
            /** Default interaction mode. */
            mode: AgentDefaultModeSchema.default("build"),
            /** Default permission mode. */
            permission: PermissionModeSchema.default("full"),
          })
          .default({}),
        /** Per-session safety limits (Claude provider only). */
        guardrails: z
          .object({
            /** Stop the agent if session cost exceeds this USD amount. 0 disables. */
            maxBudgetUsd: z.number().nonnegative().finite().default(0),
            /** Stop the agent after this many turns. 0 disables. */
            maxTurns: z.number().int().nonnegative().default(0),
          })
          .default({}),
      })
      .default({}),

    /** Model inference settings. */
    model: z
      .object({
        /** Default values for model selection. */
        defaults: z
          .object({
            /** Default AI provider. */
            provider: ProviderIdSchema.default("claude"),
            /** Default model identifier. */
            id: z.string().default("claude-opus-4-8"),
            /** Default reasoning effort level. */
            reasoning: ReasoningLevelSchema.default("high"),
            /** Fallback model when the primary is unavailable. Empty string disables fallback. */
            fallbackId: z.string().trim().default("claude-sonnet-4-6"),
            /**
             * Default context window mode. "200k" is the universally supported tier;
             * "1m" requests the extended 1M-token window from Opus 4.8/4.7/4.6 and Sonnet 4.6.
             * Models that do not support 1M ignore this and run on 200k.
             */
            contextWindow: ContextWindowModeSchema.default("200k"),
            /**
             * Default boolean thinking toggle. Honored only by models that expose
             * thinking as a boolean (Haiku 4.5). Effort-tier models ignore this and
             * use their reasoning level instead.
             */
            thinking: z.boolean().default(false),
          })
          .default({}),
        /** Provider and model for lightweight utility tasks (PR drafts, diff summaries, etc.). */
        utility: z
          .object({
            /** AI provider for utility tasks. Empty string inherits from model.defaults.provider. */
            provider: ProviderIdSchema.or(z.literal("")).default(""),
            /** Model ID for utility tasks. Empty string selects a provider-appropriate cheap default. */
            id: z.string().default(""),
          })
          .default({}),
      })
      .default({}),

    /** Versioned Terminal settings and custom profiles. */
    terminal: TerminalSettingsSchema().default(() =>
      getDefaultTerminalSettingsDocument().terminal),

    /** Notification settings. */
    notifications: z
      .object({
        /** Whether desktop notifications are enabled. */
        enabled: z.boolean().default(true),
      })
      .default({}),

    /** Thread lifecycle settings. */
    thread: z
      .object({
        /** User-completion lifecycle settings. */
        completion: z
          .object({
            /** Days before a completed thread becomes eligible for deletion. */
            retentionDays: CompletedThreadRetentionDaysSchema.default(3),
          })
          .default({}),
      })
      .default({}),

    /** Git worktree settings. */
    worktree: z
      .object({
        /** Branch naming settings for new worktrees. */
        naming: z
          .object({
            /** Naming strategy for new worktree branches. */
            mode: NamingModeSchema.default("auto"),
            /** Whether to prompt for confirmation when using AI-generated names. */
            aiConfirmation: z.boolean().default(true),
          })
          .default({}),
      })
      .default({}),

    /** Server child process settings. */
    server: z
      .object({
        /** Memory settings for the server process. */
        memory: z
          .object({
            /** Electron V8 cap or Bun soft process-RSS budget in MiB. Valid range: 256-8192. */
            heapMb: z
              .preprocess(
                (value) =>
                  value === SERVER_HEAP_LEGACY_DEFAULT_MB ? undefined : value,
                z
                  .number()
                  .int()
                  .min(SERVER_HEAP_MIN_MB)
                  .max(SERVER_HEAP_MAX_MB)
                  .default(SERVER_HEAP_DEFAULT_MB),
              ),
          })
          .default({}),
        /** Grace period before auto-shutdown after all UI sessions disconnect. */
        gracePeriod: z
          .object({
            /** Seconds to wait. 0 shuts down immediately. Max 300 (5 minutes). */
            seconds: z.number().int().min(0).max(300).default(GRACE_PERIOD_DEFAULT_SECONDS),
          })
          .default({}),
      })
      .default({}),

    /** Provider-specific configuration. */
    provider: z
      .object({
        /** Per-provider enable flag. Disabled providers cannot start new sessions. */
        enabled: z
          .object({
            claude: z.boolean().default(true),
            codex: z.boolean().default(true),
            copilot: z.boolean().default(true),
            gemini: z.boolean().default(false),
            cursor: z.boolean().default(false),
            opencode: z.boolean().default(false),
          })
          .default({}),
        /** CLI binary paths. Empty string means auto-discover from PATH. */
        cli: z
          .object({
            /** Path to the Codex CLI binary. Empty uses PATH lookup. */
            codex: z.string().default(""),
            /** Path to the Claude CLI binary. Empty uses PATH lookup. */
            claude: z.string().default(""),
            /** Path to the Copilot CLI binary. Empty uses PATH lookup. */
            copilot: z.string().default(""),
            /** Path to the Cursor Agent CLI (`cursor-agent` / `agent`). Empty uses PATH lookup. */
            cursor: z.string().default(""),
            /** Path to the OpenCode CLI (`opencode`). Empty uses PATH lookup. */
            opencode: z.string().default(""),
          })
          .default({}),
        /** OpenAI Codex CLI (`codex app-server`) tuning (`provider` + `codex` keeps depth ≤ 3). */
        codex: z
          .object({
            /**
             * When true, pass `serviceTier: "priority"` on Codex turns (OpenAI "Fast" tier when the model supports it).
             */
            fastMode: z.boolean().optional(),
            /** @deprecated Migrated into {@link fastMode}; still read from disk for older settings files. */
            priorityProcessing: z.boolean().optional(),
          })
          .transform((o) => ({
            fastMode:
              typeof o.fastMode === "boolean"
                ? o.fastMode
                : o.priorityProcessing === true,
          }))
          .default({ fastMode: false }),
        /** Cursor ACP-only tuning (`provider` + `cursor` keeps nesting depth ≤ 3). */
        cursor: z
          .object({
            /**
             * When true, omit sticky preamble shortening and ship the stitched
             * instructions/skills catalogue on every prompt (highest fidelity,
             * largest token footprint).
             */
            alwaysSendFullInstructions: z.boolean().default(false),
            /**
             * When sticky shortening is enabled, force a full preamble again every N
             * prompts across the MCP subprocess lifecycle. Zero disables.
             */
            fullPreambleEveryNTurns: z.number().int().min(0).max(999).default(12),
            /** Idle minutes before an unused cursor-agent subprocess is torn down (5–240). */
            idleSessionTtlMinutes: z.number().int().min(5).max(240).default(20),
            /**
             * Retry a failed `session/prompt` RPC once when the CLI error looks transient
             * (timeouts, opaque 502/503, etc.).
             */
            retryTransientFailuresOnce: z.boolean().default(true),
            /**
             * Base backoff (ms) before the single retry of a rate-limited prompt
             * (`resource_exhausted`). A random jitter up to 2s is added on top so
             * concurrent rate-limited turns don't all retry at the same instant and
             * re-trip Cursor's burst limit. Zero retries immediately.
             */
            rateLimitRetryBackoffMs: z.number().int().min(0).max(60_000).default(3000),
            /** Attach stderr tail excerpts to Cursor failure logs (debugging only). */
            verboseFailureLogs: z.boolean().default(true),
            /**
             * Log sanitized `session/update` envelopes plus mapped `AgentEvent` summaries while
             * handling Cursor ACP traffic (daily server log files).
             *
             * **Note:** `agent_message_chunk` updates are intentionally skipped as they are too chatty.
             */
            traceSessionUpdates: z.boolean().default(false),
            /**
             * Respond to blocking `cursor/ask_question` with automatic option picks derived
             * from prompts (recommended-first). When false, answer `skipped`.
             */
            autoAnswerAskQuestions: z.boolean().default(true),
            /**
             * Emit synthetic `cursor:ask_question:auto` agent system events summarizing picks.
             */
            echoAskQuestionsToTimeline: z.boolean().default(false),
            /**
             * Team member email used to select Cursor Admin API usage rows.
             * Empty string disables account-level usage lookup.
             */
            usageEmail: CursorUsageEmailSchema.default(""),
          })
          .default({}),
      })
      .default({}),

    /** Chat behavior settings. */
    chat: z
      .object({
        /** Handoff pipeline behavior settings. */
        handoff: z
          .object({
            /**
             * When true, show a banner in child fork threads when the handoff was
             * produced by the local deterministic path because the provider was unavailable.
             */
            notifyOnLocalFallback: z.boolean().default(true),
          })
          .default({}),
      })
      .default({}),

    /** PR draft generation settings. */
    prDraft: z
      .object({})
      .default({}),

    /** Diff summary generation settings. */
    diffSummary: z
      .object({
        /** Enable the AI-generated Summary tab in the diff panel. */
        enabled: z.boolean().default(false),
      })
      .default({}),

    /** In-app browser preview settings. */
    preview: z
      .object({
        /**
         * Memory-saver discard policy (ADR 0002). Thresholds are milliseconds.
         * Background preview tabs are discarded (renderer freed) and reload on
         * reopen; the active tab stays warm while the panel is visible.
         */
        memorySaver: z
          .object({
            /** Most-recently-used warm tabs kept when the panel is hidden. */
            maxWarm: z.number().int().min(1).max(20).default(3),
            /** Idle time before a background tab is discarded while the panel is visible (ms). */
            bgIdleMs: z.number().int().min(30_000).max(3_600_000).default(300_000),
            /** Idle time after the panel hides before the warm set is trimmed (ms). */
            hiddenIdleMs: z.number().int().min(5_000).max(600_000).default(60_000),
          })
          .default({}),
      })
      .default({}),

    /** App auto-update settings. */
    updates: z
      .object({
        /**
         * Release line to follow. Stable uses tagged releases; nightly uses automated
         * prerelease builds from the default branch (when published by maintainers).
         */
        channel: UpdateReleaseLineSchema.default("stable"),
        /** Whether to automatically download available updates. */
        autoDownload: z.boolean().default(true),
        /** Whether to automatically install updates when the app quits. */
        autoInstallOnQuit: z.boolean().default(true),
        /** How often to check for updates. */
        checkInterval: UpdateCheckIntervalSchema.default("4hours"),
      })
      .default({}),

    /** External "open in" app preferences. */
    externalApps: z
      .object({
        /**
         * Global default open-in app id (registry id, e.g. "code"). Tier 2 of the
         * three-tier resolution in ADR-0005. Empty string means unset, so the
         * split button auto-resolves to the highest-priority installed editor.
         */
        defaultEditor: z.string().default(""),
      })
      .default({}),
  }),
);

/** Full settings object with all defaults applied. */
export type Settings = z.infer<ReturnType<typeof SettingsSchema>>;

/** Returns a fresh default settings object by parsing an empty input. */
export function getDefaultSettings(): Settings {
  return SettingsSchema().parse({});
}

// ---------------------------------------------------------------------------
// Partial settings schema (for deep-partial updates)
// ---------------------------------------------------------------------------

/**
 * Deep-partial settings schema for incremental updates via `settings.update`.
 *
 * Hand-authored with `.optional()` instead of `.default()` so that absent
 * fields remain `undefined` after parsing rather than being backfilled with
 * schema defaults. Using `SettingsSchema().deepPartial()` would preserve
 * the `.default()` wrappers, causing Zod to inject default values for every
 * omitted sibling when a parent object is present in the input.
 */
export const PartialSettingsSchema = lazySchema(() =>
  z.object({
    meta: z
      .object({
        schemaVersion: z.literal(TERMINAL_SETTINGS_SCHEMA_VERSION).optional(),
      })
      .strict()
      .optional(),
    appearance: z
      .object({
        theme: ThemeSchema.optional(),
      })
      .optional(),
    agent: z
      .object({
        maxConcurrent: z.number().int().positive().optional(),
        defaults: z
          .object({
            mode: AgentDefaultModeSchema.optional(),
            permission: PermissionModeSchema.optional(),
          })
          .optional(),
        guardrails: z
          .object({
            maxBudgetUsd: z.number().nonnegative().finite().optional(),
            maxTurns: z.number().int().nonnegative().optional(),
          })
          .optional(),
      })
      .optional(),
    model: z
      .object({
        defaults: z
          .object({
            provider: ProviderIdSchema.optional(),
            id: z.string().optional(),
            reasoning: ReasoningLevelSchema.optional(),
            fallbackId: z.string().trim().optional(),
            contextWindow: ContextWindowModeSchema.optional(),
            thinking: z.boolean().optional(),
          })
          .optional(),
        utility: z
          .object({
            provider: ProviderIdSchema.or(z.literal("")).optional(),
            id: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    terminal: z
      .object({
        presentation: TerminalPresentationSettingsSchema().partial().strict().optional(),
        behavior: TerminalBehaviorSettingsSchema().partial().strict().optional(),
        accessibility: TerminalAccessibilitySettingsSchema().partial().strict().optional(),
      })
      .strict()
      .optional(),
    notifications: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
    thread: z
      .object({
        completion: z
          .object({
            retentionDays: CompletedThreadRetentionDaysSchema.optional(),
          })
          .optional(),
      })
      .optional(),
    worktree: z
      .object({
        naming: z
          .object({
            mode: NamingModeSchema.optional(),
            aiConfirmation: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    server: z
      .object({
        memory: z
          .object({
            heapMb: z
              .number()
              .int()
              .min(SERVER_HEAP_MIN_MB)
              .max(SERVER_HEAP_MAX_MB)
              .optional(),
          })
          .optional(),
        gracePeriod: z
          .object({
            seconds: z.number().int().min(0).max(300).optional(),
          })
          .optional(),
      })
      .optional(),
    provider: z
      .object({
        enabled: z
          .object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            copilot: z.boolean().optional(),
            gemini: z.boolean().optional(),
            cursor: z.boolean().optional(),
            opencode: z.boolean().optional(),
          })
          .optional(),
        cli: z
          .object({
            codex: z.string().optional(),
            claude: z.string().optional(),
            copilot: z.string().optional(),
            cursor: z.string().optional(),
            opencode: z.string().optional(),
          })
          .optional(),
        cursor: z
          .object({
            alwaysSendFullInstructions: z.boolean().optional(),
            fullPreambleEveryNTurns: z.number().int().min(0).max(999).optional(),
            idleSessionTtlMinutes: z.number().int().min(5).max(240).optional(),
            retryTransientFailuresOnce: z.boolean().optional(),
            rateLimitRetryBackoffMs: z.number().int().min(0).max(60_000).optional(),
            verboseFailureLogs: z.boolean().optional(),
            traceSessionUpdates: z.boolean().optional(),
            autoAnswerAskQuestions: z.boolean().optional(),
            echoAskQuestionsToTimeline: z.boolean().optional(),
            usageEmail: CursorUsageEmailSchema.optional(),
          })
          .optional(),
        codex: z
          .object({
            fastMode: z.boolean().optional(),
            priorityProcessing: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    chat: z
      .object({
        handoff: z
          .object({
            notifyOnLocalFallback: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    prDraft: z.object({}).optional(),
    diffSummary: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
    preview: z
      .object({
        memorySaver: z
          .object({
            maxWarm: z.number().int().min(1).max(20).optional(),
            bgIdleMs: z.number().int().min(30_000).max(3_600_000).optional(),
            hiddenIdleMs: z.number().int().min(5_000).max(600_000).optional(),
          })
          .optional(),
      })
      .optional(),
    updates: z
      .object({
        channel: UpdateReleaseLineSchema.optional(),
        autoDownload: z.boolean().optional(),
        autoInstallOnQuit: z.boolean().optional(),
        checkInterval: UpdateCheckIntervalSchema.optional(),
      })
      .optional(),
    externalApps: z
      .object({
        defaultEditor: z.string().optional(),
      })
      .optional(),
  }),
);

/** Deep-partial settings for incremental updates. */
export type PartialSettings = z.infer<ReturnType<typeof PartialSettingsSchema>>;
