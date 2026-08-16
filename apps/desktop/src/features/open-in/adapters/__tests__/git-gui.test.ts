import { describe, expect, it } from "vitest";
import { createGitGuiAdapter } from "../git-gui";

describe("createGitGuiAdapter", () => {
  it("exposes gitGui-kind metadata from its config", () => {
    const adapter = createGitGuiAdapter({
      id: "github-desktop",
      label: "GitHub Desktop",
      iconKey: "githubDesktop",
      command: "github",
    });

    expect(adapter.id).toBe("github-desktop");
    expect(adapter.label).toBe("GitHub Desktop");
    expect(adapter.kind).toBe("gitGui");
    expect(adapter.iconKey).toBe("githubDesktop");
  });

  it("rejects launch when the git GUI is not installed", async () => {
    const adapter = createGitGuiAdapter({
      id: "missing-gui",
      label: "Missing GUI",
      iconKey: "githubDesktop",
      command: "definitely-not-a-real-command-xyz",
    });

    expect(adapter.detect()).toBe(false);
    await expect(adapter.launch({ path: "/abs/x" })).rejects.toThrow(
      /Git GUI not detected: missing-gui/,
    );
  });
});
