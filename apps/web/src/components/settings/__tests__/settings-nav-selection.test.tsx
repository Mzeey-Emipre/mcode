import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SettingsNav } from "../SettingsNav";

/** Verify SettingsNav uses background-fill selection instead of a CSS pseudo-element stripe. */
describe("SettingsNav selection indicator", () => {
  it("selected button has no before: pseudo-element classes", () => {
    render(<SettingsNav section="model" onSection={() => {}} />);
    const selected = screen.getByRole("button", { name: "Model" });
    expect(selected.className).not.toContain("before:");
  });

  it("selected button has bg-primary class", () => {
    render(<SettingsNav section="model" onSection={() => {}} />);
    const selected = screen.getByRole("button", { name: "Model" });
    expect(selected.className).toContain("bg-primary");
  });

  it("unselected button has no before: pseudo-element classes", () => {
    render(<SettingsNav section="model" onSection={() => {}} />);
    // "Agent" is in the same group but not selected
    const unselected = screen.getByRole("button", { name: "Agent" });
    expect(unselected.className).not.toContain("before:");
  });
});
