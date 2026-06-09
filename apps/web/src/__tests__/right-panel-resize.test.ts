// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const RIGHT_PANEL_SRC = readFileSync(
  new URL("../components/panels/RightPanel.tsx", import.meta.url),
  "utf-8",
);

describe("RightPanel resize handle stacking", () => {
  it("keeps the col-resize handle above the terminal tab layer", () => {
    expect(RIGHT_PANEL_SRC).toMatch(/z-20[^"]*cursor-col-resize/);
    expect(RIGHT_PANEL_SRC).toMatch(/terminalActive && "z-10"/);
  });
});
