import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Favicon } from "./favicon";

describe("Favicon", () => {
  it("retries with a replacement source after the previous image fails", () => {
    const { rerender } = render(
      <Favicon
        src="https://one.example/favicon.ico"
        fallback={<span>Fallback favicon</span>}
        imageTestId="favicon-image"
      />,
    );

    fireEvent.error(screen.getByTestId("favicon-image"));
    expect(screen.getByText("Fallback favicon")).toBeInTheDocument();

    rerender(
      <Favicon
        src="https://two.example/favicon.ico"
        fallback={<span>Fallback favicon</span>}
        imageTestId="favicon-image"
      />,
    );

    expect(screen.getByTestId("favicon-image")).toHaveAttribute(
      "src",
      "https://two.example/favicon.ico",
    );
    expect(screen.queryByText("Fallback favicon")).not.toBeInTheDocument();
  });
});
