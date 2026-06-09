import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { OpenInApp } from "@/transport/types";

// vi.hoisted so the refs exist inside the vi.mock factories below.
const { mockSettingsSelector, mockApps } = vi.hoisted(() => ({
  mockSettingsSelector: vi.fn(),
  mockApps: { value: [] as OpenInApp[] },
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: vi.fn((selector: (s: unknown) => unknown) => mockSettingsSelector(selector)),
}));

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => mockApps.value,
}));

import { ExternalAppsSection, buildOpenInAppOptions } from "../ExternalAppsSection";

/** Minimal OpenInApp factory for option-building assertions. */
function app(partial: Partial<OpenInApp> & Pick<OpenInApp, "id">): OpenInApp {
  return {
    label: partial.id,
    kind: "editor",
    iconKey: partial.id,
    detected: true,
    ...partial,
  };
}

const CODE = app({ id: "code", label: "VS Code", iconKey: "vscode" });
const CURSOR = app({ id: "cursor", label: "Cursor", iconKey: "cursor" });
const ZED_UNDETECTED = app({ id: "zed", label: "Zed", iconKey: "zed", detected: false });

describe("buildOpenInAppOptions", () => {
  it("always offers Auto first with an empty value", () => {
    const opts = buildOpenInAppOptions([CODE], "");
    expect(opts[0]).toMatchObject({ value: "", label: "Auto" });
  });

  it("lists only detected apps after Auto", () => {
    const opts = buildOpenInAppOptions([CODE, CURSOR, ZED_UNDETECTED], "");
    expect(opts.map((o) => o.value)).toEqual(["", "code", "cursor"]);
  });

  it("keeps a saved-but-uninstalled id selectable as not installed", () => {
    const opts = buildOpenInAppOptions([CODE], "zed");
    const stale = opts.find((o) => o.value === "zed");
    expect(stale).toBeDefined();
    expect(stale?.label).toContain("not installed");
  });

  it("does not duplicate a saved id that is installed", () => {
    const opts = buildOpenInAppOptions([CODE], "code");
    expect(opts.filter((o) => o.value === "code")).toHaveLength(1);
  });
});

/** Configures the settings store mock to return the given defaultEditor + update spy. */
function renderSection(defaultEditor: string) {
  const update = vi.fn();
  const state = { settings: { externalApps: { defaultEditor } }, update };
  mockSettingsSelector.mockImplementation((selector: (s: unknown) => unknown) => selector(state));
  render(<ExternalAppsSection />);
  return { update };
}

describe("ExternalAppsSection", () => {
  it("renders the heading and labeled control", () => {
    mockApps.value = [CODE];
    renderSection("");
    expect(screen.getByText("External Apps")).toBeInTheDocument();
    expect(screen.getByText("Default open-in app")).toBeInTheDocument();
  });

  it("shows Auto on the trigger when no global default is set", () => {
    mockApps.value = [CODE];
    renderSection("");
    expect(
      screen.getByTestId("settings-default-open-in-trigger"),
    ).toHaveTextContent("Auto");
  });

  it("shows the selected app label on the trigger when a default is set", () => {
    mockApps.value = [CODE];
    renderSection("code");
    expect(
      screen.getByTestId("settings-default-open-in-trigger"),
    ).toHaveTextContent("VS Code");
  });
});
