import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { OpenInApp } from "@/transport/types";

// The collapsed open-in seam: the renderer talks to a single transport method,
// `openIn(appId, path, line)`. These tests drive FileEditorPicker through a fake
// transport and assert it dispatches with the right app id and path - proving
// editor launches and file-manager reveals share one method.

const apps: OpenInApp[] = [
  { id: "code", label: "VS Code", kind: "editor", iconKey: "vscode", detected: true },
  {
    id: "explorer",
    label: "File Explorer",
    kind: "fileManager",
    iconKey: "explorer",
    detected: true,
  },
];

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => apps,
}));

const openIn = vi.fn().mockResolvedValue(undefined);
vi.mock("@/transport", () => ({
  getTransport: () => ({ openIn }),
}));

import { FileEditorPicker } from "../FileEditorPicker";

describe("FileEditorPicker open-in seam", () => {
  beforeEach(() => {
    openIn.mockClear();
  });

  it("dispatches openIn with the editor app id, file path, and line", () => {
    render(
      <FileEditorPicker
        filePath="/abs/repo/src/x.ts"
        dirPath="/abs/repo/src"
        line={42}
        trigger={<button>Open</button>}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByText("VS Code"));

    expect(openIn).toHaveBeenCalledWith("code", "/abs/repo/src/x.ts", 42);
  });

  it("dispatches openIn with the file-manager app id and dir path for Reveal", () => {
    render(
      <FileEditorPicker
        filePath="/abs/repo/src/x.ts"
        dirPath="/abs/repo/src"
        trigger={<button>Open</button>}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByText("Reveal in file manager"));

    expect(openIn).toHaveBeenCalledWith("explorer", "/abs/repo/src");
  });
});
