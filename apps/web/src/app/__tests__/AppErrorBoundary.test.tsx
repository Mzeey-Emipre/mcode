import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "../AppErrorBoundary";

/** Throws during rendering to exercise the boundary's recovery path. */
function ThrowingChild(): never {
  throw new Error("render failed");
}

describe("AppErrorBoundary", () => {
  it("leaves healthy application content unchanged", () => {
    render(
      <AppErrorBoundary>
        <div>Application content</div>
      </AppErrorBoundary>,
    );

    expect(screen.getByText("Application content")).toBeInTheDocument();
  });

  it("renders recovery UI and reports a descendant render failure", () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const reportRendererCrash = vi.fn().mockResolvedValue(undefined);
    const previousBridge = window.desktopBridge;
    const testBridge = {
      reportRendererCrash,
    } satisfies Pick<NonNullable<typeof window.desktopBridge>, "reportRendererCrash">;
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: testBridge,
      writable: true,
    });

    render(
      <AppErrorBoundary>
        <ThrowingChild />
      </AppErrorBoundary>,
    );

    expect(
      screen.getByRole("heading", { name: "Mcode ran into a problem" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Reload the app to continue.")).toBeInTheDocument();
    expect(diagnostic).toHaveBeenCalledWith(
      "[AppErrorBoundary] Caught application render error",
      "Error",
      expect.any(String),
    );
    expect(reportRendererCrash).toHaveBeenCalledWith({
      errorName: "Error",
      componentStack: expect.any(String),
    });

    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: previousBridge,
      writable: true,
    });
    diagnostic.mockRestore();
  });

  it("reloads after the user activates recovery", () => {
    const reload = vi.fn();
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <AppErrorBoundary onReload={reload}>
        <ThrowingChild />
      </AppErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload Mcode" }));

    expect(reload).toHaveBeenCalledOnce();
    diagnostic.mockRestore();
  });
});
