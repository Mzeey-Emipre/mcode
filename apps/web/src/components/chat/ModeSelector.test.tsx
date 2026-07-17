import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ModeSelector } from "./ModeSelector";

describe("ModeSelector", () => {
  it.each(["worktree", "existing-worktree"] as const)(
    "uses the shared worktree glyph for %s mode",
    (mode) => {
      const { container } = render(
        <ModeSelector mode={mode} onModeChange={vi.fn()} locked />,
      );

      expect(container.querySelector('[data-slot="worktree-mode-icon"]')).not.toBeNull();
      expect(screen.getByText("Worktree")).toBeInTheDocument();
    },
  );
});
