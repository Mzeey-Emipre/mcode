import { describe, it, expect } from "vitest";
import { SettingsSchema, getDefaultSettings } from "../models/settings.js";

describe("SettingsSchema", () => {
  describe("server.memory.heapMb", () => {
    it("defaults to 512 when parsing an empty object", () => {
      const result = SettingsSchema().parse({});
      expect(result.server.memory.heapMb).toBe(512);
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
      expect(getDefaultSettings().server.memory.heapMb).toBe(512);
    });
  });
});
