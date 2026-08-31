import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PathLabel } from "../PathLabel";

describe("PathLabel", () => {
  it("renders the path and exposes it in a tooltip", async () => {
    render(<PathLabel path="/opt/mcode" />);
    const path = screen.getByText("/opt/mcode");
    const user = userEvent.setup();

    expect(path).toBeInTheDocument();
    await user.hover(path);
    await waitFor(() => {
      const tooltip = document.querySelector<HTMLElement>("[data-slot='tooltip-content']");
      expect(tooltip).toBeVisible();
      expect(tooltip).toHaveTextContent("/opt/mcode");
    });
  });

  it("collapses $HOME prefix to ~ while retaining the full path in a tooltip", async () => {
    render(<PathLabel path="/Users/cj/src/mcode" home="/Users/cj" />);
    const path = screen.getByText("~/src/mcode");
    const user = userEvent.setup();

    expect(path).toHaveTextContent("~/src/mcode");
    await user.hover(path);
    await waitFor(() => {
      const tooltip = document.querySelector<HTMLElement>("[data-slot='tooltip-content']");
      expect(tooltip).toBeVisible();
      expect(tooltip).toHaveTextContent("/Users/cj/src/mcode");
    });
  });

  it("does not collapse if home is not a prefix and exposes the path in a tooltip", async () => {
    render(<PathLabel path="/opt/mcode" home="/Users/cj" />);
    const path = screen.getByText("/opt/mcode");
    const user = userEvent.setup();

    expect(path).toHaveTextContent("/opt/mcode");
    await user.hover(path);
    await waitFor(() => {
      const tooltip = document.querySelector<HTMLElement>("[data-slot='tooltip-content']");
      expect(tooltip).toBeVisible();
      expect(tooltip).toHaveTextContent("/opt/mcode");
    });
  });

  it("accepts a className override", () => {
    render(<PathLabel path="/a/b" className="custom-class" />);
    expect(document.querySelector(".custom-class")).not.toBeNull();
  });
});
