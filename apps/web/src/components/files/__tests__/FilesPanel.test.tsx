import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilesPanel } from "../FilesPanel";

describe("FilesPanel", () => {
  it("provides a reusable file shell with shared right-panel resizing", () => {
    const onWidthChange = vi.fn();
    render(
      <FilesPanel
        title="Changed files"
        count={34}
        ariaLabel="Changed files"
        width={256}
        minWidth={220}
        maxWidth="calc(100% - 440px)"
        defaultWidth={256}
        wideWidth={480}
        getMaxWidth={() => 640}
        onWidthChange={onWidthChange}
        controls={<div>Filter files</div>}
      >
        <div>File tree</div>
      </FilesPanel>,
    );

    const panel = screen.getByTestId("files-panel");
    expect(panel).toHaveTextContent("Changed files34Filter filesFile tree");
    const separator = screen.getByRole("separator", {
      name: "Resize Changed files",
    });
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onWidthChange).toHaveBeenCalledWith(266, "user");
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(onWidthChange).toHaveBeenCalledWith(480, "user");
  });
});
