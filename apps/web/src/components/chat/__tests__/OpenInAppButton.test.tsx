import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OpenInApp } from "@/transport/types";
import { executeCommand, getCommand, clearCommands } from "@/lib/command-registry";

// vi.hoisted so spies are available inside the hoisted vi.mock factories below.
const { openInSpy, setThreadSettingsSpy, appsRef, globalDefaultRef } = vi.hoisted(() => ({
  openInSpy: vi.fn().mockResolvedValue(undefined),
  setThreadSettingsSpy: vi.fn().mockResolvedValue(true),
  appsRef: { current: [] as OpenInApp[] },
  globalDefaultRef: { current: "" as string },
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({ openIn: openInSpy }),
}));

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => appsRef.current,
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { externalApps: { defaultEditor: globalDefaultRef.current } } }),
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: (selector: (s: unknown) => unknown) =>
    selector({ setThreadSettings: setThreadSettingsSpy }),
}));

// Base UI primitives don't run in jsdom; render plain elements instead.
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    [key: string]: unknown;
  }) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render?: React.ReactElement }) => <>{render}</>,
  TooltipContent: () => null,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({
    children,
    disabled,
    ...rest
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    [key: string]: unknown;
  }) => (
    <button disabled={disabled} {...rest}>
      {children}
    </button>
  ),
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
  }) => <button onClick={onClick}>{children}</button>,
}));

vi.mock("../openInAppIcons", () => ({
  openInAppIcon: () => null,
}));

import { OpenInAppButton } from "../OpenInAppButton";

function app(over: Partial<OpenInApp> & Pick<OpenInApp, "id">): OpenInApp {
  return { label: over.id, kind: "editor", iconKey: over.id, detected: true, ...over };
}

const VSCODE = app({ id: "code", label: "VS Code", iconKey: "vscode" });
const CURSOR = app({ id: "cursor", label: "Cursor", iconKey: "cursor" });
const WINDOWS_TERMINAL = app({
  id: "windows-terminal",
  label: "Windows Terminal",
  kind: "terminal",
  iconKey: "windows-terminal",
});
const EXPLORER = app({ id: "explorer", label: "File Explorer", kind: "fileManager", iconKey: "explorer" });

describe("OpenInAppButton", () => {
  beforeEach(() => {
    openInSpy.mockClear();
    setThreadSettingsSpy.mockClear();
    clearCommands();
    appsRef.current = [VSCODE, CURSOR, EXPLORER];
    globalDefaultRef.current = "";
  });

  it("primary click opens the resolved default (auto-detected top editor)", async () => {
    render(<OpenInAppButton dirPath="/dir" threadId="t1" threadOverride={null} />);
    await userEvent.click(screen.getByRole("button", { name: /open in vs code/i }));
    expect(openInSpy).toHaveBeenCalledWith("code", "/dir");
  });

  it("mod+o command opens the resolved default through the transport", () => {
    render(<OpenInAppButton dirPath="/dir" threadId="t1" threadOverride={null} />);
    expect(getCommand("openin.openDefault")).toBeDefined();
    executeCommand("openin.openDefault");
    expect(openInSpy).toHaveBeenCalledWith("code", "/dir");
  });

  it("honours the thread override as tier-1 default", async () => {
    render(<OpenInAppButton dirPath="/dir" threadId="t1" threadOverride="cursor" />);
    await userEvent.click(screen.getByRole("button", { name: /open in cursor/i }));
    expect(openInSpy).toHaveBeenCalledWith("cursor", "/dir");
  });

  it("falls back to the global setting when no thread override", async () => {
    globalDefaultRef.current = "cursor";
    render(<OpenInAppButton dirPath="/dir" threadId="t1" threadOverride={null} />);
    await userEvent.click(screen.getByRole("button", { name: /open in cursor/i }));
    expect(openInSpy).toHaveBeenCalledWith("cursor", "/dir");
  });

  it("picking an app opens it and writes the thread override only", async () => {
    render(<OpenInAppButton dirPath="/dir" threadId="t1" threadOverride={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Cursor" }));
    expect(openInSpy).toHaveBeenCalledWith("cursor", "/dir");
    expect(setThreadSettingsSpy).toHaveBeenCalledWith("t1", { defaultOpenInApp: "cursor" });
  });

  it("lists a detected terminal and sets it as the thread default when picked", async () => {
    appsRef.current = [VSCODE, WINDOWS_TERMINAL, EXPLORER];
    render(<OpenInAppButton dirPath="/dir" threadId="t1" threadOverride={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Windows Terminal" }));
    expect(openInSpy).toHaveBeenCalledWith("windows-terminal", "/dir");
    expect(setThreadSettingsSpy).toHaveBeenCalledWith("t1", {
      defaultOpenInApp: "windows-terminal",
    });
  });

  it("is disabled with no workspace and registers no shortcut", () => {
    render(<OpenInAppButton dirPath={null} threadId="t1" threadOverride={null} />);
    expect(screen.getByRole("button", { name: /open in vs code/i })).toBeDisabled();
    expect(getCommand("openin.openDefault")).toBeUndefined();
    expect(openInSpy).not.toHaveBeenCalled();
  });
});
