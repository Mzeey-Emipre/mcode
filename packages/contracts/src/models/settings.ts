import { z } from "zod";
import { PermissionModeSchema } from "./enums.js";

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
export const AgentDefaultModeSchema = z.enum(["chat", "plan", "agent"]);
/** Default agent interaction mode value. */
export type AgentDefaultMode = z.infer<typeof AgentDefaultModeSchema>;

/** Reasoning effort level for model inference. */
export const ReasoningLevelSchema = z.enum(["low", "medium", "high"]);
/** Reasoning effort level value. */
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/** Worktree branch naming strategy. */
export const NamingModeSchema = z.enum(["auto", "custom", "ai"]);
/** Worktree branch naming strategy value. */
export type NamingMode = z.infer<typeof NamingModeSchema>;

// ---------------------------------------------------------------------------
// Settings schema
// ---------------------------------------------------------------------------

/** Schema for the full user settings object. Every field has a default. */
export const SettingsSchema = z.object({
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
          /** Default model identifier. */
          id: z.string().default("claude-sonnet-4-6"),
          /** Default reasoning effort level. */
          reasoning: ReasoningLevelSchema.default("high"),
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
});

/** Full settings object with all defaults applied. */
export type Settings = z.infer<typeof SettingsSchema>;

/** Default settings produced by parsing an empty object. */
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

// ---------------------------------------------------------------------------
// Partial settings schema (for deep-partial updates)
// ---------------------------------------------------------------------------

/** Deep-partial settings schema for incremental updates. */
export const PartialSettingsSchema = z.object({
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
          id: z.string().optional(),
          reasoning: ReasoningLevelSchema.optional(),
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
});

/** Deep-partial settings for incremental updates. */
export type PartialSettings = z.infer<typeof PartialSettingsSchema>;
