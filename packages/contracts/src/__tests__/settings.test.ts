import { describe, it, expect } from "vitest";
import {
  SettingsSchema,
  getDefaultSettings,
  SERVER_HEAP_DEFAULT_MB,
  SERVER_HEAP_LEGACY_DEFAULT_MB,
  SERVER_HEAP_MIN_MB,
} from "../models/settings.js";

describe("SettingsSchema", () => {
  describe("model.defaults.reasoning", () => {
    it("normalizes legacy orchestration-shaped values to max", () => {
      expect(SettingsSchema().parse({
        model: { defaults: { reasoning: "ultra" } },
      }).model.defaults.reasoning).toBe("max");
      expect(SettingsSchema().parse({
        model: { defaults: { reasoning: "ultrathink" } },
      }).model.defaults.reasoning).toBe("max");
    });
  });

  describe("server.memory.heapMb", () => {
    it("defaults to the supported server heap cap when parsing an empty object", () => {
      const result = SettingsSchema().parse({});
      expect(result.server.memory.heapMb).toBe(SERVER_HEAP_DEFAULT_MB);
    });

    it("accepts a valid heapMb value", () => {
      const result = SettingsSchema().parse({ server: { memory: { heapMb: 1024 } } });
      expect(result.server.memory.heapMb).toBe(1024);
    });

    it("migrates the old shipped default to the current default", () => {
      const result = SettingsSchema().parse({
        server: { memory: { heapMb: SERVER_HEAP_LEGACY_DEFAULT_MB } },
      });
      expect(result.server.memory.heapMb).toBe(SERVER_HEAP_DEFAULT_MB);
    });

    it("rejects heapMb below the supported floor", () => {
      const result = SettingsSchema().safeParse({
        server: { memory: { heapMb: SERVER_HEAP_MIN_MB - 1 } },
      });
      expect(result.success).toBe(false);
    });

    it("rejects heapMb above maximum (8192)", () => {
      const result = SettingsSchema().safeParse({ server: { memory: { heapMb: 10000 } } });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer heapMb", () => {
      const result = SettingsSchema().safeParse({ server: { memory: { heapMb: 512.5 } } });
      expect(result.success).toBe(false);
    });

    it("includes server.memory.heapMb in getDefaultSettings", () => {
      expect(getDefaultSettings().server.memory.heapMb).toBe(SERVER_HEAP_DEFAULT_MB);
    });
  });

  describe("model.defaults.fallbackId", () => {
    it("defaults to claude-sonnet-4-6 when parsing an empty object", () => {
      const result = SettingsSchema().parse({});
      expect(result.model.defaults.fallbackId).toBe("claude-sonnet-4-6");
    });

    it("accepts a custom fallbackId", () => {
      const result = SettingsSchema().parse({
        model: { defaults: { fallbackId: "claude-haiku-4-5-20251001" } },
      });
      expect(result.model.defaults.fallbackId).toBe("claude-haiku-4-5-20251001");
    });

    it("accepts empty string to disable fallback", () => {
      const result = SettingsSchema().parse({
        model: { defaults: { fallbackId: "" } },
      });
      expect(result.model.defaults.fallbackId).toBe("");
    });

    it("includes fallbackId in getDefaultSettings()", () => {
      expect(getDefaultSettings().model.defaults.fallbackId).toBe("claude-sonnet-4-6");
    });

    it("trims whitespace so a space-only value becomes empty string", () => {
      const result = SettingsSchema().parse({
        model: { defaults: { fallbackId: "   " } },
      });
      expect(result.model.defaults.fallbackId).toBe("");
    });
  });

  describe("terminal.scrollback", () => {
    it("defaults to 1000 when parsing an empty object", () => {
      const result = SettingsSchema().parse({});
      expect(result.terminal.scrollback).toBe(1000);
    });

    it("accepts a custom scrollback value within range", () => {
      const result = SettingsSchema().parse({ terminal: { scrollback: 2500 } });
      expect(result.terminal.scrollback).toBe(2500);
    });

    it("accepts the maximum value of 5000", () => {
      const result = SettingsSchema().parse({ terminal: { scrollback: 5000 } });
      expect(result.terminal.scrollback).toBe(5000);
    });

    it("rejects negative scrollback", () => {
      const result = SettingsSchema().safeParse({ terminal: { scrollback: -1 } });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer scrollback", () => {
      const result = SettingsSchema().safeParse({ terminal: { scrollback: 100.5 } });
      expect(result.success).toBe(false);
    });

    it("clamps scrollback above 5000 down to 5000", () => {
      const result = SettingsSchema().parse({ terminal: { scrollback: 5001 } });
      expect(result.terminal.scrollback).toBe(5000);
    });

    it("clamps very large scrollback values down to 5000", () => {
      const result = SettingsSchema().parse({ terminal: { scrollback: 100000 } });
      expect(result.terminal.scrollback).toBe(5000);
    });

    it("accepts zero for unlimited scrollback", () => {
      const result = SettingsSchema().parse({ terminal: { scrollback: 0 } });
      expect(result.terminal.scrollback).toBe(0);
    });

    it("includes terminal.scrollback in getDefaultSettings()", () => {
      expect(getDefaultSettings().terminal.scrollback).toBe(1000);
    });
  });

  describe("model.defaults.contextWindow", () => {
    it("accepts contextWindow '200k'", () => {
      const result = SettingsSchema().parse({
        model: { defaults: { contextWindow: "200k" } },
      });
      expect(result.model.defaults.contextWindow).toBe("200k");
    });

    it("accepts contextWindow '1m'", () => {
      const result = SettingsSchema().parse({
        model: { defaults: { contextWindow: "1m" } },
      });
      expect(result.model.defaults.contextWindow).toBe("1m");
    });

    it("defaults contextWindow to '200k' when omitted", () => {
      const result = SettingsSchema().parse({});
      expect(result.model.defaults.contextWindow).toBe("200k");
    });

    it("rejects numeric contextWindow", () => {
      expect(() =>
        SettingsSchema().parse({
          model: { defaults: { contextWindow: 1_000_000 } },
        }),
      ).toThrow();
    });

    it("rejects unknown contextWindow strings", () => {
      expect(() =>
        SettingsSchema().parse({
          model: { defaults: { contextWindow: "1M" } },
        }),
      ).toThrow();
    });
  });

  describe("agent.defaults.mode", () => {
    it("normalizes legacy chat to build", () => {
      const result = SettingsSchema().parse({
        agent: { defaults: { mode: "chat" } },
      });
      expect(result.agent.defaults.mode).toBe("build");
    });

    it("accepts build, plan, and agent unchanged", () => {
      for (const mode of ["build", "plan", "agent"] as const) {
        const result = SettingsSchema().parse({
          agent: { defaults: { mode } },
        });
        expect(result.agent.defaults.mode).toBe(mode);
      }
    });

    it("rejects unknown mode values", () => {
      const result = SettingsSchema().safeParse({
        agent: { defaults: { mode: "unknown" } },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("model.defaults.thinking", () => {
    it("accepts thinking true", () => {
      const result = SettingsSchema().parse({
        model: { defaults: { thinking: true } },
      });
      expect(result.model.defaults.thinking).toBe(true);
    });

    it("defaults thinking to false when omitted", () => {
      const result = SettingsSchema().parse({});
      expect(result.model.defaults.thinking).toBe(false);
    });

    it("rejects non-boolean thinking", () => {
      expect(() =>
        SettingsSchema().parse({
          model: { defaults: { thinking: "yes" } },
        }),
      ).toThrow();
    });
  });
});
