import { describe, expect, it } from "vitest";
import {
  addCodexDeveloperInstructions,
  composeCodexDeveloperInstructions,
} from "../../private/codex/codex-app-server.js";

describe("Codex instruction boundaries", () => {
  it("adds instructions to both start and resume payload shapes", () => {
    const instructions = "mcode runtime";
    expect(addCodexDeveloperInstructions({ cwd: "/repo" }, instructions)).toEqual({
      cwd: "/repo",
      developerInstructions: instructions,
    });
    expect(addCodexDeveloperInstructions({ threadId: "thread-1" }, instructions)).toEqual({
      threadId: "thread-1",
      developerInstructions: instructions,
    });
  });

  it("composes configured instructions before Mcode guidance", () => {
    expect(composeCodexDeveloperInstructions("user rules", "mcode runtime"))
      .toBe("user rules\n\nmcode runtime");
    expect(composeCodexDeveloperInstructions(undefined, "mcode runtime")).toBe("mcode runtime");
    expect(composeCodexDeveloperInstructions("  ", "mcode runtime")).toBe("mcode runtime");
    expect(composeCodexDeveloperInstructions("mcode runtime", "mcode runtime"))
      .toBe("mcode runtime");
    expect(composeCodexDeveloperInstructions("user rules\n\nmcode runtime", "mcode runtime"))
      .toBe("user rules\n\nmcode runtime");
    expect(composeCodexDeveloperInstructions("before\nmcode runtime\nafter", "mcode runtime"))
      .toBe("before\nmcode runtime\nafter");
    expect(composeCodexDeveloperInstructions("foobar", "foo"))
      .toBe("foobar\n\nfoo");
    expect(composeCodexDeveloperInstructions("user rules", undefined)).toBe("user rules");
  });
});
