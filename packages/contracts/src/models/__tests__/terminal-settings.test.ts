import { describe, expect, it } from "vitest";
import {
  getDefaultTerminalSettingsDocument,
  migrateLegacyTerminalScrollback,
  TerminalPreferencesUpdateSchema,
  TerminalSettingsDocumentSchema,
} from "../terminal-settings.js";

describe("Terminal v1 settings", () => {
  it("provides a strict bounded default document", () => {
    const defaults = getDefaultTerminalSettingsDocument();
    expect(TerminalSettingsDocumentSchema().parse(defaults)).toEqual(defaults);
    expect(defaults.terminal.presentation.fontFamily).toBe(
      '"JetBrains Mono Variable", "JetBrains Mono", "SF Mono", "Cascadia Code", "Consolas", monospace',
    );
    expect(defaults.terminal.behavior).toMatchObject({ scrollback: 1000, sessionLimit: 20 });
    expect(() =>
      TerminalSettingsDocumentSchema().parse({
        ...defaults,
        terminal: { ...defaults.terminal, unexpected: true },
      }),
    ).toThrow();
  });

  it.each([
    [0, 5000],
    [1, 100],
    [99, 100],
    [100, 100],
    [5000, 5000],
    [5001, 5000],
  ])("maps legacy scrollback %i to %i", (legacy, expected) => {
    expect(migrateLegacyTerminalScrollback(legacy)).toBe(expected);
  });

  it("rejects invalid profile bounds and inconsistent watermarks", () => {
    const defaults = getDefaultTerminalSettingsDocument();
    expect(() =>
      TerminalSettingsDocumentSchema().parse({
        ...defaults,
        terminal: {
          ...defaults.terminal,
          profiles: [
            {
              id: "custom:11111111-1111-4111-8111-111111111111",
              name: "x",
              executable: "tool",
              arguments: ["x".repeat(8193)],
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      TerminalSettingsDocumentSchema().parse({
        ...defaults,
        terminal: {
          ...defaults.terminal,
          flowControl: { ...defaults.terminal.flowControl, clientLowBytes: 262_144 },
        },
      }),
    ).toThrow();
  });

  it("requires custom defaults to reference a configured profile", () => {
    const defaults = getDefaultTerminalSettingsDocument();
    expect(() =>
      TerminalSettingsDocumentSchema().parse({
        ...defaults,
        terminal: {
          ...defaults.terminal,
          defaultProfileId: "custom:11111111-1111-4111-8111-111111111111",
        },
      }),
    ).toThrow(/default profile/i);
  });

  it("rejects preference updates without a defined field", () => {
    expect(() => TerminalPreferencesUpdateSchema().parse({ presentation: {} })).toThrow();
    expect(() => TerminalPreferencesUpdateSchema().parse({ behavior: undefined })).toThrow();
    expect(TerminalPreferencesUpdateSchema().parse({ presentation: { fontSize: "lg" } })).toEqual({
      presentation: { fontSize: "lg" },
    });
  });
});
