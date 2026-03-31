import { describe, it, expect, beforeAll } from "vitest";

describe("snapshot-entry", () => {
  beforeAll(async () => {
    // Importing the entry module assigns to globalThis.__v8Snapshot
    await import("../snapshot-entry.js");
  });

  it("sets __v8Snapshot on globalThis", () => {
    expect(globalThis.__v8Snapshot).toBeDefined();
  });

  it("provides SettingsSchema", () => {
    const schema = globalThis.__v8Snapshot!.contracts.SettingsSchema;
    expect(schema).toBeDefined();
    // Verify it's a working Zod schema by parsing defaults
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("provides getExtension", () => {
    const { getExtension } = globalThis.__v8Snapshot!.contracts;
    expect(getExtension("photo.png")).toBe("png");
    expect(getExtension("archive.tar.gz")).toBe("gz");
    expect(getExtension("noext")).toBe("");
  });

  it("freezes the snapshot exports", () => {
    expect(Object.isFrozen(globalThis.__v8Snapshot)).toBe(true);
    expect(Object.isFrozen(globalThis.__v8Snapshot!.contracts)).toBe(true);
  });
});
