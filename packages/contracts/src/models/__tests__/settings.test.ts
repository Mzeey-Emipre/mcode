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
      verboseFailureLogs: true,
      traceSessionUpdates: false,
      autoAnswerAskQuestions: true,
      echoAskQuestionsToTimeline: false,
    });
  });

  it("accepts PartialSettings overrides for Cursor ACP knobs", () => {
    const parsed = PartialSettingsSchema().parse({
      provider: {
        cursor: {
          alwaysSendFullInstructions: true,
          fullPreambleEveryNTurns: 0,
          idleSessionTtlMinutes: 60,
        },
      },
    });
    expect(parsed.provider?.cursor?.alwaysSendFullInstructions).toBe(true);
    expect(parsed.provider?.cursor?.fullPreambleEveryNTurns).toBe(0);
    expect(parsed.provider?.cursor?.idleSessionTtlMinutes).toBe(60);
  });
});
