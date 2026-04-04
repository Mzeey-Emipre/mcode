import { describe, it, expect } from "vitest";
import { SettingsSchema, getDefaultSettings } from "../models/settings.js";

describe("SettingsSchema", () => {
  describe("server.memory.heapMb", () => {
    it("defaults to 96 when parsing an empty object", () => {
      const result = SettingsSchema().parse({});
      expect(result.server.memory.heapMb).toBe(96);
    });

    it("accepts a valid heapMb value", () => {
      const result = SettingsSchema().parse({ server: { memory: { heapMb: 1024 } } });
      expect(result.server.memory.heapMb).toBe(1024);
    });

    it("rejects heapMb below minimum (64)", () => {
      const result = SettingsSchema().safeParse({ server: { memory: { heapMb: 32 } } });
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
      expect(getDefaultSettings().server.memory.heapMb).toBe(96);
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
    it("defaults to 250 when parsing an empty object", () => {
      const result = SettingsSchema().parse({});
      expect(result.terminal.scrollback).toBe(250);
    });

    it("accepts a custom scrollback value", () => {
      const result = SettingsSchema().parse({ terminal: { scrollback: 1000 } });
      expect(result.terminal.scrollback).toBe(1000);
    });

    it("rejects negative scrollback", () => {
      const result = SettingsSchema().safeParse({ terminal: { scrollback: -1 } });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer scrollback", () => {
      const result = SettingsSchema().safeParse({ terminal: { scrollback: 100.5 } });
      expect(result.success).toBe(false);
    });

    it("accepts zero for unlimited scrollback", () => {
      const result = SettingsSchema().parse({ terminal: { scrollback: 0 } });
      expect(result.terminal.scrollback).toBe(0);
    });

    it("includes terminal.scrollback in getDefaultSettings()", () => {
      expect(getDefaultSettings().terminal.scrollback).toBe(250);
    });
  });
});
