import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import {
  TERMINAL_DEFAULT_SESSION_LIMIT,
  TERMINAL_MAX_SESSIONS,
  TerminalCustomProfileSchema,
  TerminalProfileReferenceSchema,
  TerminalTimestampSchema,
  TerminalUuidSchema,
} from "./terminal.js";

/** Terminal settings document schema version. */
export const TERMINAL_SETTINGS_SCHEMA_VERSION = "0.0.1" as const;
/** Minimum retained renderer lines. */
export const TERMINAL_MIN_SCROLLBACK_LINES = 100;
/** Maximum retained renderer lines. */
export const TERMINAL_MAX_SCROLLBACK_LINES = 5_000;
/** Default retained renderer lines. */
export const TERMINAL_DEFAULT_SCROLLBACK_LINES = 1_000;

const fontFamilySchema = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Control characters are forbidden");

/** Terminal presentation preferences. */
export const TerminalPresentationSettingsSchema = lazySchema(() =>
  z
    .object({
      fontFamily: fontFamilySchema(),
      fontSize: z.enum(["xs", "sm", "md", "lg", "xl"]),
      lineHeight: z.enum(["compact", "normal", "relaxed"]),
      cursorStyle: z.enum(["block", "underline", "bar"]),
      cursorBlink: z.boolean(),
      ligatures: z.boolean(),
    })
    .strict(),
);

/** Terminal behavior preferences. */
export const TerminalBehaviorSettingsSchema = lazySchema(() =>
  z
    .object({
      scrollback: z.number().int().min(TERMINAL_MIN_SCROLLBACK_LINES).max(TERMINAL_MAX_SCROLLBACK_LINES),
      sessionLimit: z.number().int().min(1).max(TERMINAL_MAX_SESSIONS),
      confirmOnKill: z.enum(["never", "withChildProcesses", "always"]),
      copyOnSelect: z.boolean(),
      confirmMultilinePaste: z.boolean(),
    })
    .strict(),
);

/** Terminal accessibility preferences. */
export const TerminalAccessibilitySettingsSchema = lazySchema(() =>
  z.object({ screenReaderMode: z.enum(["off", "auto", "on"]) }).strict(),
);

/** Fixed Terminal flow-control thresholds. */
export const TerminalFlowControlSettingsSchema = lazySchema(() =>
  z
    .object({
      serverHighBytes: z.literal(1_048_576),
      serverLowBytes: z.literal(262_144),
      clientHighBytes: z.literal(262_144),
      clientLowBytes: z.literal(65_536),
    })
    .strict(),
);

/** Complete Terminal settings subtree. */
export const TerminalSettingsSchema = lazySchema(() =>
  z
    .object({
      defaultProfileId: TerminalProfileReferenceSchema(),
      profiles: z.array(TerminalCustomProfileSchema()).max(32),
      presentation: TerminalPresentationSettingsSchema(),
      behavior: TerminalBehaviorSettingsSchema(),
      accessibility: TerminalAccessibilitySettingsSchema(),
      flowControl: TerminalFlowControlSettingsSchema(),
    })
    .strict()
    .superRefine((value, context) => {
      const ids = value.profiles.map((profile) => profile.id);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Custom profile IDs must be unique" });
      }
      if (value.defaultProfileId.startsWith("custom:") && !ids.includes(value.defaultProfileId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "The default profile must reference a configured custom profile",
          path: ["defaultProfileId"],
        });
      }
    }),
);

/** Versioned Terminal settings document. */
export const TerminalSettingsDocumentSchema = lazySchema(() =>
  z
    .object({
      meta: z.object({ schemaVersion: z.literal(TERMINAL_SETTINGS_SCHEMA_VERSION) }).strict(),
      terminal: TerminalSettingsSchema(),
    })
    .strict(),
);

/** Workspace-only Terminal profile preference. */
export const WorkspaceTerminalPreferenceSchema = lazySchema(() =>
  z
    .object({
      workspaceId: TerminalUuidSchema(),
      defaultProfileId: TerminalProfileReferenceSchema(),
      updatedAt: TerminalTimestampSchema(),
    })
    .strict(),
);

/** Recovery details exposed while a persisted Terminal document is blocked. */
export const TerminalProfileRecoverySchema = lazySchema(() =>
  z
    .object({
      status: z.literal("blocked"),
      reason: z.enum(["malformed", "future-version", "missing-profile-reference", "migration-write-failed"]),
      blockedProfiles: z.array(TerminalCustomProfileSchema()).max(32),
      unavailableProfileId: TerminalProfileReferenceSchema().nullable(),
    })
    .strict(),
);

/** Mutable Terminal preferences accepted by the dedicated update operation. */
export const TerminalPreferencesUpdateSchema = lazySchema(() =>
  z
    .object({
      presentation: TerminalPresentationSettingsSchema().partial().strict().optional(),
      behavior: TerminalBehaviorSettingsSchema().partial().strict().optional(),
      accessibility: TerminalAccessibilitySettingsSchema().partial().strict().optional(),
    })
    .strict()
    .refine(
      (value) => Object.values(value).some(
        (group) => group !== undefined && Object.values(group).some((field) => field !== undefined),
      ),
      "At least one preference field is required",
    ),
);

/** Maps any nonnegative legacy scrollback value into the Terminal v1 range. */
export function migrateLegacyTerminalScrollback(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Legacy Terminal scrollback must be a nonnegative integer");
  }
  if (value === 0 || value > TERMINAL_MAX_SCROLLBACK_LINES) {
    return TERMINAL_MAX_SCROLLBACK_LINES;
  }
  return Math.max(value, TERMINAL_MIN_SCROLLBACK_LINES);
}

/** Returns a new Terminal v1 settings document with frozen defaults. */
export function getDefaultTerminalSettingsDocument(): TerminalSettingsDocument {
  return {
    meta: { schemaVersion: TERMINAL_SETTINGS_SCHEMA_VERSION },
    terminal: {
      defaultProfileId: "automatic",
      profiles: [],
      presentation: {
        fontFamily: "mcodeMono",
        fontSize: "sm",
        lineHeight: "normal",
        cursorStyle: "block",
        cursorBlink: false,
        ligatures: false,
      },
      behavior: {
        scrollback: TERMINAL_DEFAULT_SCROLLBACK_LINES,
        sessionLimit: TERMINAL_DEFAULT_SESSION_LIMIT,
        confirmOnKill: "withChildProcesses",
        copyOnSelect: false,
        confirmMultilinePaste: true,
      },
      accessibility: { screenReaderMode: "off" },
      flowControl: {
        serverHighBytes: 1_048_576,
        serverLowBytes: 262_144,
        clientHighBytes: 262_144,
        clientLowBytes: 65_536,
      },
    },
  };
}

/** Versioned Terminal settings document. */
export type TerminalSettingsDocument = z.infer<ReturnType<typeof TerminalSettingsDocumentSchema>>;
/** Complete Terminal settings subtree. */
export type TerminalSettings = z.infer<ReturnType<typeof TerminalSettingsSchema>>;
/** Workspace Terminal profile preference. */
export type WorkspaceTerminalPreference = z.infer<ReturnType<typeof WorkspaceTerminalPreferenceSchema>>;
/** Recovery details exposed while a persisted Terminal document is blocked. */
export type TerminalProfileRecovery = z.infer<ReturnType<typeof TerminalProfileRecoverySchema>>;
/** Partial dedicated Terminal preferences update. */
export type TerminalPreferencesUpdate = z.infer<ReturnType<typeof TerminalPreferencesUpdateSchema>>;
