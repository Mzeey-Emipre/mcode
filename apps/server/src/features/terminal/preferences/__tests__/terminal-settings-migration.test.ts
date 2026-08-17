import { describe, expect, it } from "vitest";
import { getDefaultSettings } from "@mcode/contracts";
import {
  migrateTerminalSettingsDocument,
  type TerminalSettingsMigrationResult,
} from "../terminal-settings-migration.js";

function currentDocument(result: TerminalSettingsMigrationResult) {
  if (result.status === "blocked") {
    throw new Error(`Expected a settings document, got ${result.reason}`);
  }
  return result.document;
}

describe("Terminal settings migration", () => {
  it.each([
    [0, 5_000],
    [1, 100],
    [99, 100],
    [100, 100],
    [5_000, 5_000],
    [5_001, 5_000],
  ])("maps legacy scrollback %i to %i", (legacy, expected) => {
    const result = migrateTerminalSettingsDocument({
      appearance: { theme: "dark" },
      terminal: { scrollback: legacy },
    });

    expect(result.status).toBe("migrated");
    expect(currentDocument(result).terminal.behavior.scrollback).toBe(expected);
    expect(currentDocument(result).appearance.theme).toBe("dark");
  });

  it("moves legacy fields, preserves flow control, and is idempotent", () => {
    const first = migrateTerminalSettingsDocument({
      terminal: {
        scrollback: 250,
        confirmOnKill: "panel",
        flowControl: {
          serverHighBytes: 1_048_576,
          serverLowBytes: 262_144,
          clientHighBytes: 262_144,
          clientLowBytes: 65_536,
        },
      },
    });

    expect(first.status).toBe("migrated");
    const migrated = currentDocument(first);
    expect(migrated.meta.schemaVersion).toBe("0.0.1");
    expect(migrated.terminal.behavior).toMatchObject({
      scrollback: 250,
      confirmOnKill: "withChildProcesses",
    });
    expect(migrated.terminal.flowControl).toEqual({
      serverHighBytes: 1_048_576,
      serverLowBytes: 262_144,
      clientHighBytes: 262_144,
      clientLowBytes: 65_536,
    });

    const second = migrateTerminalSettingsDocument(migrated);
    expect(second).toEqual({ status: "current", document: migrated });
  });

  it("blocks malformed and unsupported future documents without changing them", () => {
    const malformed = { terminal: { scrollback: "many" } };
    const future = { meta: { schemaVersion: "0.1.0" }, terminal: {} };

    expect(migrateTerminalSettingsDocument(malformed)).toEqual({
      status: "blocked",
      reason: "malformed",
      original: malformed,
    });
    expect(migrateTerminalSettingsDocument(future)).toEqual({
      status: "blocked",
      reason: "future-version",
      original: future,
    });
  });

  it("keeps a missing custom default visible as a distinct blocked state", () => {
    const defaults = getDefaultSettings();
    const value = {
      ...defaults,
      terminal: {
        ...defaults.terminal,
        defaultProfileId: "custom:11111111-1111-4111-8111-111111111111",
      },
    };

    expect(migrateTerminalSettingsDocument(value)).toEqual({
      status: "blocked",
      reason: "missing-profile-reference",
      original: value,
    });
  });
});
