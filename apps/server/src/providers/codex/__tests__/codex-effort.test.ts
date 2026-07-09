import { describe, expect, it } from "vitest";
import { toCodexEffort } from "../codex-types.js";

describe("toCodexEffort", () => {
  it("passes GPT-5.6 max and ultra efforts to the app-server", () => {
    expect(toCodexEffort("max")).toBe("max");
    expect(toCodexEffort("ultra")).toBe("ultra");
  });

  it("keeps Claude's virtual ultrathink tier out of the Codex protocol", () => {
    expect(toCodexEffort("ultrathink")).toBe("high");
  });
});
