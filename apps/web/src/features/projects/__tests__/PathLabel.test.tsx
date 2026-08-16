import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PathLabel } from "../PathLabel";

describe("PathLabel", () => {
  it("renders the path", () => {
    render(<PathLabel path="/opt/mcode" />);
    expect(screen.getByTitle("/opt/mcode")).toBeInTheDocument();
  });

  it("collapses $HOME prefix to ~", () => {
    render(<PathLabel path="/Users/cj/src/mcode" home="/Users/cj" />);
    const el = screen.getByTitle("/Users/cj/src/mcode");
    expect(el.textContent).toBe("~/src/mcode");
  });

  it("does not collapse if home is not a prefix", () => {
    render(<PathLabel path="/opt/mcode" home="/Users/cj" />);
    const el = screen.getByTitle("/opt/mcode");
    expect(el.textContent).toBe("/opt/mcode");
  });

  it("accepts a className override", () => {
    render(<PathLabel path="/a/b" className="custom-class" />);
    expect(document.querySelector(".custom-class")).not.toBeNull();
  });
});
