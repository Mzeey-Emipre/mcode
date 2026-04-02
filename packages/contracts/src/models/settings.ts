import { z } from "zod";
import { InteractionModeSchema, PermissionModeSchema } from "./enums.js";
import { lazySchema } from "../utils/lazySchema.js";

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
 */
export const AgentDefaultModeSchema = z.enum([
  ...InteractionModeSchema.options,
  "agent",
]);
/** Default agent interaction mode value. */
export type AgentDefaultMode = z.infer<typeof AgentDefaultModeSchema>;

/** Reasoning effort level for model inference. */
export const ReasoningLevelSchema = z.enum(["low", "medium", "high", "max"]);
/** Reasoning effort level value. */
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/** Supported AI provider identifier for settings. */
export const ProviderIdSchema = z.enum(["claude", "codex", "gemini", "copilot", "cursor", "opencode"]);
/** Supported AI provider identifier value. */
export type SettingsProviderId = z.infer<typeof ProviderIdSchema>;

/** Worktree branch naming strategy. */
export const NamingModeSchema = z.enum(["auto", "custom", "ai"]);
/** Worktree branch naming strategy value. */
export type NamingMode = z.infer<typeof NamingModeSchema>;

// ---------------------------------------------------------------------------
// Settings schema
// ---------------------------------------------------------------------------

/** Schema for the full user settings object. Every field has a default. */
export const SettingsSchema = lazySchema(() =>
  z.object({
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
            mode: AgentDefaultModeSchema.default("chat"),
            /** Default permission mode. */
            permission: PermissionModeSchema.default("full"),
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
            id: z.string().default("claude-sonnet-4-6"),
            /** Default reasoning effort level. */
            reasoning: ReasoningLevelSchema.default("high"),
            /** Fallback model when the primary is unavailable. Empty string disables fallback. */
            fallbackId: z.string().trim().default("claude-sonnet-4-6"),
          })
          .default({}),
      })
      .default({}),

    /** Terminal emulator settings. */
    terminal: z
      .object({
        /** Number of scrollback lines to retain. */
        scrollback: z.number().int().nonnegative().default(500),
      })
      .default({}),

    /** Notification settings. */
    notifications: z
      .object({
        /** Whether desktop notifications are enabled. */
        enabled: z.boolean().default(true),
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
            /** V8 max old space size in MB. Valid range: 64-8192. Default tuned for < 100MB idle. */
            heapMb: z.number().int().min(64).max(8192).default(96),
          })
          .default({}),
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
          })
          .optional(),
      })
      .optional(),
    terminal: z
      .object({
        scrollback: z.number().int().nonnegative().optional(),
      })
      .optional(),
    notifications: z
      .object({
        enabled: z.boolean().optional(),
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
            heapMb: z.number().int().min(64).max(8192).optional(),
          })
          .optional(),
      })
      .optional(),
  }),
);

/** Deep-partial settings for incremental updates. */
export type PartialSettings = z.infer<ReturnType<typeof PartialSettingsSchema>>;
