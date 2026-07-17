import { beforeEach, describe, expect, it } from "vitest";

import {
  readRememberedComposerMode,
  rememberComposerMode,
} from "../composer-mode-preference";

describe("composer mode preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each(["direct", "worktree", "existing-worktree"] as const)(
    "remembers %s",
    (mode) => {
      rememberComposerMode(mode);
      expect(readRememberedComposerMode()).toBe(mode);
    },
  );

  it("falls back to direct when stored data is invalid", () => {
    window.localStorage.setItem("mcode-composer-mode", "invalid");
    expect(readRememberedComposerMode()).toBe("direct");
  });
});
