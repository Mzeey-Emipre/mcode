import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ImageAttachmentLightbox } from "./ImageAttachmentLightbox";

const createItems = (source: string, count = 3) =>
  Array.from({ length: count }, (_, index) => ({
    src: `https://example.test/${source}-${String(index + 1)}.png`,
    title: `Image ${String(index + 1)}`,
  }));

describe("ImageAttachmentLightbox", () => {
  it("keeps the full-screen preview below the desktop title bar", async () => {
    render(
      <ImageAttachmentLightbox
        open
        onOpenChange={vi.fn()}
        items={[
          {
            src: "data:image/png;base64,iVBORw0KGgo=",
            title: "Screenshot",
          },
        ]}
      />,
    );

    const popup = await screen.findByRole("dialog");
    expect(popup).toHaveClass("app-viewport-fixed");
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass(
      "app-viewport-fixed",
    );
  });

  it("keeps the selected slide when attachment URLs refresh", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ImageAttachmentLightbox open onOpenChange={vi.fn()} items={createItems("fallback")} />,
    );

    await user.click(screen.getByRole("button", { name: "Next image" }));
    await user.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByRole("img", { name: "Image 3" })).toHaveAttribute(
      "src",
      "https://example.test/fallback-3.png",
    );

    rerender(
      <ImageAttachmentLightbox open onOpenChange={vi.fn()} items={createItems("transport")} />,
    );

    expect(screen.getByRole("img", { name: "Image 3" })).toHaveAttribute(
      "src",
      "https://example.test/transport-3.png",
    );
  });

  it("keeps the focused slide dot when attachment URLs refresh", () => {
    const { rerender } = render(
      <ImageAttachmentLightbox open onOpenChange={vi.fn()} items={createItems("fallback")} />,
    );
    const secondDot = screen.getByRole("button", { name: "Go to image 2 of 3" });
    secondDot.focus();
    expect(secondDot).toHaveFocus();

    rerender(
      <ImageAttachmentLightbox open onOpenChange={vi.fn()} items={createItems("transport")} />,
    );

    expect(screen.getByRole("button", { name: "Go to image 2 of 3" })).toHaveFocus();
  });

  it("clamps the selected slide when the tray shrinks", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ImageAttachmentLightbox open onOpenChange={vi.fn()} items={createItems("original")} />,
    );

    await user.click(screen.getByRole("button", { name: "Next image" }));
    await user.click(screen.getByRole("button", { name: "Next image" }));
    rerender(
      <ImageAttachmentLightbox open onOpenChange={vi.fn()} items={createItems("shrunk", 2)} />,
    );
    expect(screen.getByRole("img", { name: "Image 2" })).toHaveAttribute(
      "src",
      "https://example.test/shrunk-2.png",
    );

    rerender(
      <ImageAttachmentLightbox open onOpenChange={vi.fn()} items={createItems("restored")} />,
    );
    expect(screen.getByRole("img", { name: "Image 2" })).toHaveAttribute(
      "src",
      "https://example.test/restored-2.png",
    );
  });

  it("uses the requested initial index each time the dialog opens", async () => {
    const user = userEvent.setup();
    const items = createItems("attachment");
    const { rerender } = render(
      <ImageAttachmentLightbox open onOpenChange={vi.fn()} items={items} initialIndex={0} />,
    );

    await user.click(screen.getByRole("button", { name: "Next image" }));
    await user.click(screen.getByRole("button", { name: "Next image" }));
    rerender(
      <ImageAttachmentLightbox open={false} onOpenChange={vi.fn()} items={items} initialIndex={1} />,
    );
    rerender(
      <ImageAttachmentLightbox open onOpenChange={vi.fn()} items={items} initialIndex={1} />,
    );

    expect(screen.getByRole("img", { name: "Image 2" })).toHaveAttribute(
      "src",
      "https://example.test/attachment-2.png",
    );
  });

  it("clears the failed-image state when the current source changes", () => {
    const { rerender } = render(
      <ImageAttachmentLightbox open onOpenChange={vi.fn()} items={createItems("fallback", 1)} />,
    );

    fireEvent.error(screen.getByRole("img", { name: "Image 1" }));
    expect(screen.getByText("Could not load this image. Close the preview or press Escape.")).toBeVisible();

    rerender(
      <ImageAttachmentLightbox open onOpenChange={vi.fn()} items={createItems("transport", 1)} />,
    );

    expect(screen.getByRole("img", { name: "Image 1" })).toHaveAttribute(
      "src",
      "https://example.test/transport-1.png",
    );
  });
});
