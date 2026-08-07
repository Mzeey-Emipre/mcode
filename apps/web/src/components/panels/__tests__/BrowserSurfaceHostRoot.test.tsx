import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserSurfaceHostRoot,
  browserSurfaceHost,
} from "../BrowserSurfaceHostRoot";
import type { BrowserSurfaceIdentity } from "@/services/browser-surfaces";

const IDENTITY: BrowserSurfaceIdentity = {
  workspaceId: "workspace-1",
  scope: { kind: "thread", id: "thread-1" },
  tabId: "web-preview",
};

describe("BrowserSurfaceHostRoot", () => {
  afterEach(() => browserSurfaceHost.dispose(IDENTITY));

  it("mounts a hosted iframe outside the panel tree", () => {
    render(<BrowserSurfaceHostRoot />);

    browserSurfaceHost.create(IDENTITY, {
      address: `${window.location.origin}/browser-automation-fixture.html`,
    });

    const iframe = screen.getByTestId("web-runtime-preview-iframe");
    expect(iframe.parentElement).toHaveAttribute("data-browser-surface-host");
    expect(iframe).toHaveAttribute("data-workspace-id", "workspace-1");
    expect(iframe).toHaveAttribute("data-scope-kind", "thread");
    expect(iframe).toHaveAttribute("data-scope-id", "thread-1");
    expect(iframe).toHaveAttribute("data-tab-id", "web-preview");
  });
});
