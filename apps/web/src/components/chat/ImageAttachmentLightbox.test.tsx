import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ImageAttachmentLightbox } from "./ImageAttachmentLightbox";

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
});
