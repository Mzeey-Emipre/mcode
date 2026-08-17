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

describe("conversation memory settings", () => {
  it("does not expose the retired thread-cache memory control", () => {
    expect(getDefaultSettings()).not.toHaveProperty("performance");
    expect(SettingsSchema().parse({ performance: { threadCacheSize: 50 } }))
      .not.toHaveProperty("performance");
    expect(PartialSettingsSchema().parse({ performance: { threadCacheSize: 12 } }))
      .not.toHaveProperty("performance");
  });
});

describe("thread.completion.retentionDays", () => {
  it("defaults to 3 days", () => {
    expect(getDefaultSettings().thread.completion.retentionDays).toBe(3);
  });

  it.each([null, 1, 365])("accepts %s", (retentionDays) => {
    expect(
      SettingsSchema().parse({ thread: { completion: { retentionDays } } })
        .thread.completion.retentionDays,
    ).toBe(retentionDays);
    expect(
      PartialSettingsSchema().parse({ thread: { completion: { retentionDays } } })
        .thread?.completion?.retentionDays,
    ).toBe(retentionDays);
  });

  it.each([0, -1, 366, 1.5, "3", "never", {}, []])(
    "rejects malformed value %j at full and partial settings boundaries",
    (retentionDays) => {
      const input = { thread: { completion: { retentionDays } } };
      expect(SettingsSchema().safeParse(input).success).toBe(false);
      expect(PartialSettingsSchema().safeParse(input).success).toBe(false);
    },
  );
});

describe("thread.completion.unsafeWorktreePolicy", () => {
  it("defaults to block and accepts partial updates", () => {
    expect(getDefaultSettings().thread.completion.unsafeWorktreePolicy).toBe("block");
    expect(PartialSettingsSchema().parse({
      thread: { completion: { unsafeWorktreePolicy: "delete" } },
    }).thread?.completion?.unsafeWorktreePolicy).toBe("delete");
  });

  it.each(["allow", "always", 1, null, {}])("rejects invalid policy %j", (unsafeWorktreePolicy) => {
    const input = { thread: { completion: { unsafeWorktreePolicy } } };
    expect(SettingsSchema().safeParse(input).success).toBe(false);
    expect(PartialSettingsSchema().safeParse(input).success).toBe(false);
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

describe("preview settings", () => {
  it("does not expose a rendering-engine choice", () => {
    expect(getDefaultSettings().preview).not.toHaveProperty("rendering");
    expect(
      SettingsSchema().parse({
        preview: { rendering: { engine: "webContentsView" } },
      }).preview,
    ).not.toHaveProperty("rendering");
    expect(
      PartialSettingsSchema().parse({
        preview: { rendering: { engine: "webview" } },
      }).preview,
    ).not.toHaveProperty("rendering");
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
