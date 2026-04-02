import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingRow } from "@/components/settings/SettingRow";

describe("SettingRow", () => {
  it("renders label and children", () => {
    render(<SettingRow label="My Setting"><span>content</span></SettingRow>);
    expect(screen.getByText("My Setting")).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("renders hint when provided", () => {
    render(<SettingRow label="X" hint="Some hint"><span /></SettingRow>);
    expect(screen.getByText("Some hint")).toBeTruthy();
  });

  it("accepts configKey prop without error", () => {
    const { container } = render(<SettingRow label="X" configKey="foo.bar"><span /></SettingRow>);
    expect(container.querySelector("div")).toBeTruthy();
  });

  it("omits hint element when hint not provided", () => {
    // queryByRole("paragraph") is unreliable in jsdom; query the DOM directly.
    const { container } = render(<SettingRow label="X"><span /></SettingRow>);
    expect(container.querySelector("p")).toBeNull();
  });
});
