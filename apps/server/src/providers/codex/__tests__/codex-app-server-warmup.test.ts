import { describe, it, expect } from "vitest";
import { warmCodexAppServer } from "../codex-app-server.js";

describe("warmCodexAppServer", () => {
  it("resolves false for a missing binary without throwing", async () => {
    await expect(
      warmCodexAppServer("definitely-not-a-real-binary-xyz", 5000),
    ).resolves.toBe(false);
  });
});
