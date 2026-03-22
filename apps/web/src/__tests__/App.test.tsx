import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { App } from "../app/App";

describe("App", () => {
  it("renders the app title", () => {
    render(<App />);
    expect(screen.getByText("Mcode")).toBeInTheDocument();
  });

  it("renders the subtitle", () => {
    render(<App />);
    expect(screen.getByText("AI Agent Orchestration")).toBeInTheDocument();
  });
});
