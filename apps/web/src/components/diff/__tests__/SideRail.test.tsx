import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// FileEditorPicker (rendered when absolutePath is provided) pulls in
// useOpenInApps which calls the IPC transport. Tests don't bootstrap
// the transport, so stub the hook to return no apps.
vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => [],
}));

import { SideRail } from "../SideRail";

describe("SideRail", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders Diff and Copy path for non-markdown files (no Preview)", () => {
    render(
      <SideRail
        filePath="src/x.ts"
        isMarkdown={false}
        previewMode={false}
        onTogglePreview={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /show raw diff/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show rendered preview/i })).toBeNull();
    expect(screen.getByRole("button", { name: /copy file path/i })).toBeInTheDocument();
  });

  it("renders Preview when isMarkdown is true", () => {
    render(
      <SideRail
        filePath="x.md"
        isMarkdown
        previewMode={false}
        onTogglePreview={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /show rendered preview/i })).toBeInTheDocument();
  });

  it("marks Diff as pressed when not in preview, Preview when in preview", () => {
    const { rerender } = render(
      <SideRail filePath="x.md" isMarkdown previewMode={false} onTogglePreview={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /show raw diff/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    rerender(
      <SideRail filePath="x.md" isMarkdown previewMode onTogglePreview={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /show rendered preview/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("calls onTogglePreview only when switching to a different mode", async () => {
    const onToggle = vi.fn();
    render(
      <SideRail filePath="x.md" isMarkdown previewMode={false} onTogglePreview={onToggle} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /show raw diff/i }));
    expect(onToggle).not.toHaveBeenCalled(); // already in diff mode
    await userEvent.click(screen.getByRole("button", { name: /show rendered preview/i }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("Copy path falls back to the relative filePath when absolutePath is absent", async () => {
    render(
      <SideRail
        filePath="apps/web/src/x.ts"
        isMarkdown={false}
        previewMode={false}
        onTogglePreview={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /copy file path/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("apps/web/src/x.ts");
  });

  it("Copy path prefers the absolute on-disk path when provided", async () => {
    render(
      <SideRail
        filePath="apps/web/src/x.ts"
        absolutePath="C:/Users/me/repo/apps/web/src/x.ts"
        isMarkdown={false}
        previewMode={false}
        onTogglePreview={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /copy file path/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "C:/Users/me/repo/apps/web/src/x.ts",
    );
  });

  it("shows an error toast when the clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const show = vi.fn();
    const { useToastStore } = await import("@/stores/toastStore");
    vi.spyOn(useToastStore, "getState").mockReturnValue({ show } as never);

    render(
      <SideRail
        filePath="apps/web/src/x.ts"
        isMarkdown={false}
        previewMode={false}
        onTogglePreview={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /copy file path/i }));
    expect(show).toHaveBeenCalledWith(
      "error",
      "Couldn't copy path",
      "Clipboard API is unavailable in this environment.",
    );
  });

  it("does not keep the rail expanded after a mouse click (no focus-visible pin)", async () => {
    render(
      <SideRail
        filePath="x.md"
        isMarkdown
        previewMode={false}
        onTogglePreview={vi.fn()}
      />,
    );
    const nav = screen.getByRole("navigation", { name: /file actions/i });
    const copyBtn = screen.getByRole("button", { name: /copy file path/i });

    await userEvent.click(copyBtn);

    // Mouse click gives :focus but not :focus-visible — the rail should stay
    // collapsed (w-8) rather than the old focus-within pin (w-[152px]).
    expect(nav).toHaveClass("w-8");
    expect(nav).not.toHaveClass("w-[152px]");
  });
});
