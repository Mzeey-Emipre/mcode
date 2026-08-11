import {
  PartialSettingsSchema,
  SettingsSchema,
  TERMINAL_SETTINGS_SCHEMA_VERSION,
  getDefaultSettings,
  migrateLegacyTerminalScrollback,
  type Settings,
} from "@mcode/contracts";
import { z } from "zod";

const legacyFlowControlSchema = z
  .object({
    serverHighBytes: z.literal(1_048_576).optional(),
    serverLowBytes: z.literal(262_144).optional(),
    clientHighBytes: z.literal(262_144).optional(),
    clientLowBytes: z.literal(65_536).optional(),
  })
  .strict();

const legacyTerminalSchema = z
  .object({
    scrollback: z.number().int().nonnegative().optional(),
    confirmOnKill: z.enum(["never", "editor", "panel", "always"]).optional(),
    flowControl: legacyFlowControlSchema.optional(),
  })
  .strict();

/** Result of loading or migrating the persisted Terminal settings document. */
export type TerminalSettingsMigrationResult =
  | { readonly status: "current" | "migrated"; readonly document: Settings }
  | {
      readonly status: "blocked";
      readonly reason: "malformed" | "future-version" | "missing-profile-reference";
      readonly original: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Migrates one legacy settings document to Terminal schema 0.0.1 in memory. */
export function migrateTerminalSettingsDocument(value: unknown): TerminalSettingsMigrationResult {
  if (!isRecord(value)) {
    return { status: "blocked", reason: "malformed", original: value };
  }

  if (value.meta !== undefined) {
    if (
      !isRecord(value.meta)
      || value.meta.schemaVersion !== TERMINAL_SETTINGS_SCHEMA_VERSION
    ) {
      return { status: "blocked", reason: "future-version", original: value };
    }
    const current = SettingsSchema().safeParse(value);
    return current.success
      ? { status: "current", document: current.data }
      : {
          status: "blocked",
          reason: hasMissingCustomProfileReference(value)
            ? "missing-profile-reference"
            : "malformed",
          original: value,
        };
  }

  const legacyTerminal = legacyTerminalSchema.safeParse(value.terminal ?? {});
  if (!legacyTerminal.success) {
    return { status: "blocked", reason: "malformed", original: value };
  }

  const rootWithoutTerminal = { ...value };
  delete rootWithoutTerminal.terminal;
  const legacyRoot = PartialSettingsSchema().safeParse(rootWithoutTerminal);
  if (!legacyRoot.success) {
    return { status: "blocked", reason: "malformed", original: value };
  }

  const defaults = getDefaultSettings();
  const legacy = legacyTerminal.data;
  const migrated = SettingsSchema().safeParse({
    ...legacyRoot.data,
    meta: { schemaVersion: TERMINAL_SETTINGS_SCHEMA_VERSION },
    terminal: {
      ...defaults.terminal,
      behavior: {
        ...defaults.terminal.behavior,
        ...(legacy.scrollback === undefined
          ? {}
          : { scrollback: migrateLegacyTerminalScrollback(legacy.scrollback) }),
        ...(legacy.confirmOnKill === undefined
          ? {}
          : {
              confirmOnKill:
                legacy.confirmOnKill === "never" || legacy.confirmOnKill === "always"
                  ? legacy.confirmOnKill
                  : "withChildProcesses",
            }),
      },
      flowControl: {
        ...defaults.terminal.flowControl,
        ...legacy.flowControl,
      },
    },
  });

  return migrated.success
    ? { status: "migrated", document: migrated.data }
    : { status: "blocked", reason: "malformed", original: value };
}

function hasMissingCustomProfileReference(value: Record<string, unknown>): boolean {
  if (!isRecord(value.terminal)) return false;
  const defaultProfileId = value.terminal.defaultProfileId;
  if (typeof defaultProfileId !== "string" || !defaultProfileId.startsWith("custom:")) {
    return false;
  }
  const profiles = value.terminal.profiles;
  return Array.isArray(profiles) && !profiles.some(
    (profile) => isRecord(profile) && profile.id === defaultProfileId,
  );
}
