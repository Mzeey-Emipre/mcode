import { describe, it, expect } from "vitest";
import { warmCodexAppServer } from "../codex-app-server.js";

describe("warmCodexAppServer", () => {
  it("resolves an uninitialized result for a missing binary without throwing", async () => {
    await expect(
      warmCodexAppServer("definitely-not-a-real-binary-xyz", 100),
    ).resolves.toEqual({ initialized: false });
  });
});
