import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileCode2 } from "lucide-react";
import { FileTypeIcon } from "../file-type-icon";

vi.mock("@/lib/vscode-icons", () => ({
  resolveIcon: vi.fn(async (fileName: string) =>
    fileName.endsWith(".ts")
      ? { type: "vscode", url: "blob:typescript-icon" }
      : { type: "lucide", icon: FileCode2 },
  ),
}));

describe("FileTypeIcon", () => {
  it("renders a VSCode CDN icon when available", async () => {
    render(<FileTypeIcon filePath="apps/web/src/index.ts" />);

    await waitFor(() => {
      expect(screen.getByTestId("file-type-icon-vscode")).toHaveAttribute(
        "src",
        "blob:typescript-icon",
      );
    });
  });

  it("falls back to Lucide when VSCode icon is unavailable", async () => {
    render(<FileTypeIcon filePath="README" />);

    await waitFor(() => {
      expect(screen.getByTestId("file-type-icon-lucide")).toBeInTheDocument();
    });
  });
});
