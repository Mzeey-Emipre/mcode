import { describe, expect, it } from "vitest";
import { toCodexEffort } from "../codex-types.js";

describe("toCodexEffort", () => {
  it("passes GPT-5.6 max effort to the app-server", () => {
    expect(toCodexEffort("max")).toBe("max");
  });

  it("maps proactive orchestration to the provider-native Ultra tier", () => {
    expect(toCodexEffort("medium", "proactive")).toBe("ultra");
    expect(toCodexEffort(undefined, "proactive")).toBe("ultra");
  });
});
