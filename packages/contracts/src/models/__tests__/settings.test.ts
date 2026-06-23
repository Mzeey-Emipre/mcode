import { describe, it, expect } from "vitest";
import { getDefaultSettings, PartialSettingsSchema, SettingsSchema } from "../settings.js";

describe("settings.provider.enabled", () => {
  it("defaults claude/codex/copilot to true and others to false", () => {
    const s = getDefaultSettings();
    expect(s.provider.enabled).toEqual({
      claude: true, codex: true, copilot: true,
      gemini: false, cursor: false, opencode: false,
    });
  });

  it("accepts partial updates that flip individual providers", () => {
    const parsed = PartialSettingsSchema().parse({
      provider: { enabled: { codex: false } },
    });
    expect(parsed.provider?.enabled?.codex).toBe(false);
  });
});

describe("preview.memorySaver", () => {
  it("applies ADR 0002 defaults", () => {
    const s = SettingsSchema().parse({});
    expect(s.preview.memorySaver.maxWarm).toBe(3);
    expect(s.preview.memorySaver.bgIdleMs).toBe(300_000);
    expect(s.preview.memorySaver.hiddenIdleMs).toBe(60_000);
  });

  it("accepts a partial override without backfilling siblings", () => {
    const p = PartialSettingsSchema().parse({
      preview: { memorySaver: { maxWarm: 5 } },
    });
    expect(p.preview?.memorySaver?.maxWarm).toBe(5);
    expect(p.preview?.memorySaver?.bgIdleMs).toBeUndefined();
  });

  it("rejects out-of-range maxWarm", () => {
    expect(SettingsSchema().safeParse({ preview: { memorySaver: { maxWarm: 0 } } }).success).toBe(false);
  });
});

describe("settings.provider.cursor", () => {
  it("fills Cursor ACP tuning defaults", () => {
    const s = getDefaultSettings();
    expect(s.provider.cursor).toEqual({
      alwaysSendFullInstructions: false,
      fullPreambleEveryNTurns: 12,
      idleSessionTtlMinutes: 20,
      retryTransientFailuresOnce: true,
      rateLimitRetryBackoffMs: 3000,
      verboseFailureLogs: true,
      traceSessionUpdates: false,
      autoAnswerAskQuestions: true,
      echoAskQuestionsToTimeline: false,
      usageEmail: "",
    });
  });

  it("accepts PartialSettings overrides for Cursor ACP knobs", () => {
    const parsed = PartialSettingsSchema().parse({
      provider: {
        cursor: {
          alwaysSendFullInstructions: true,
          fullPreambleEveryNTurns: 0,
          idleSessionTtlMinutes: 60,
          usageEmail: "dev@example.com",
        },
      },
    });
    expect(parsed.provider?.cursor?.alwaysSendFullInstructions).toBe(true);
    expect(parsed.provider?.cursor?.fullPreambleEveryNTurns).toBe(0);
    expect(parsed.provider?.cursor?.idleSessionTtlMinutes).toBe(60);
    expect(parsed.provider?.cursor?.usageEmail).toBe("dev@example.com");
  });

  it("bounds Cursor usage email in full and partial settings", () => {
    expect(
      SettingsSchema().parse({ provider: { cursor: { usageEmail: " dev@example.com " } } })
        .provider.cursor.usageEmail,
    ).toBe("dev@example.com");
    expect(
      PartialSettingsSchema().parse({ provider: { cursor: { usageEmail: "" } } })
        .provider?.cursor?.usageEmail,
    ).toBe("");
    expect(
      SettingsSchema().safeParse({ provider: { cursor: { usageEmail: "not-an-email" } } })
        .success,
    ).toBe(false);
    expect(
      PartialSettingsSchema().safeParse({
        provider: { cursor: { usageEmail: `${"a".repeat(309)}@example.com` } },
      }).success,
    ).toBe(false);
  });
});

describe("settings.externalApps.defaultEditor", () => {
  it("defaults to an empty string (unset)", () => {
    const s = getDefaultSettings();
    expect(s.externalApps.defaultEditor).toBe("");
  });

  it("parses a valid app id", () => {
    const s = SettingsSchema().parse({ externalApps: { defaultEditor: "code" } });
    expect(s.externalApps.defaultEditor).toBe("code");
  });

  it("rejects a non-string default editor", () => {
    expect(
      SettingsSchema().safeParse({ externalApps: { defaultEditor: 42 } }).success,
    ).toBe(false);
  });

  it("accepts a PartialSettings override without backfilling siblings", () => {
    const p = PartialSettingsSchema().parse({
      externalApps: { defaultEditor: "cursor" },
    });
    expect(p.externalApps?.defaultEditor).toBe("cursor");
  });
});
