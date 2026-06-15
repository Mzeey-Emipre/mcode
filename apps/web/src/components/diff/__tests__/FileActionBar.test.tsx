import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// FileEditorPicker (rendered when absolutePath is provided) pulls in
// useOpenInApps which calls the IPC transport. Tests don't bootstrap
// the transport, so stub the hook to return no apps.
vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => [],
}));

import { FileActionBar } from "../FileActionBar";

describe("FileActionBar", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders Copy path but no Diff/Preview toggle for non-markdown files", () => {
    render(
      <FileActionBar
        filePath="src/x.ts"
        isMarkdown={false}
        previewMode={false}
        onTogglePreview={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /copy file path/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show raw diff/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /show rendered preview/i })).toBeNull();
  });

  it("renders the Diff/Preview toggle when isMarkdown is true", () => {
    render(
      <FileActionBar
        filePath="x.md"
        isMarkdown
        previewMode={false}
        onTogglePreview={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /show raw diff/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show rendered preview/i })).toBeInTheDocument();
  });

  it("marks Diff as pressed when not in preview, Preview when in preview", () => {
    const { rerender } = render(
      <FileActionBar filePath="x.md" isMarkdown previewMode={false} onTogglePreview={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /show raw diff/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    rerender(
      <FileActionBar filePath="x.md" isMarkdown previewMode onTogglePreview={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /show rendered preview/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("calls onTogglePreview only when switching to a different mode", async () => {
    const onToggle = vi.fn();
    render(
      <FileActionBar filePath="x.md" isMarkdown previewMode={false} onTogglePreview={onToggle} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /show raw diff/i }));
    expect(onToggle).not.toHaveBeenCalled(); // already in diff mode
    await userEvent.click(screen.getByRole("button", { name: /show rendered preview/i }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("Copy path falls back to the relative filePath when absolutePath is absent", async () => {
    render(
      <FileActionBar
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
      <FileActionBar
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
      <FileActionBar
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
});
