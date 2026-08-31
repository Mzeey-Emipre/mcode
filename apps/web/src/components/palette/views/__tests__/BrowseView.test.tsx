import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let pendingConfirm: (() => void) | null = null;
  let pendingBack: (() => void) | null = null;
  const palette = {
    query: "~/",
    setQuery: vi.fn(),
    setPendingConfirm: vi.fn((action: (() => void) | null) => {
      pendingConfirm = action;
    }),
    setPendingBack: vi.fn((action: (() => void) | null) => {
      pendingBack = action;
    }),
    close: vi.fn(),
  };
  const workspace = {
    createWorkspace: vi.fn(),
    beginNewThread: vi.fn(),
  };

  return {
    palette,
    workspace,
    filesystemBrowse: vi.fn(),
    getPendingConfirm: () => pendingConfirm,
    getPendingBack: () => pendingBack,
  };
});

vi.mock("@/stores/commandPaletteStore", () => ({
  useCommandPaletteStore: (selector: (state: typeof mocks.palette) => unknown) =>
    selector(mocks.palette),
}));

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.workspace) => unknown) =>
    selector(mocks.workspace),
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({ filesystemBrowse: mocks.filesystemBrowse }),
}));

vi.mock("@/lib/platform", () => ({ isMac: false }));

vi.mock("@/components/ui/command", () => ({
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => <button type="button" onClick={onSelect}>{children}</button>,
}));

import { BrowseView } from "../BrowseView";

describe("BrowseView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.palette.query = "~/";
    mocks.filesystemBrowse.mockResolvedValue({
      path: "/home/mcode",
      parent: "/home",
      entries: [
        { name: "Documents", isDir: true },
        { name: "Projects", isDir: true },
        { name: "README.md", isDir: false },
      ],
      isExactDirectory: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filters folders with the leaf query and descends into the selected folder", async () => {
    mocks.palette.query = "~/pro";

    render(<BrowseView />);

    const project = await screen.findByRole("button", { name: /projects/i });
    expect(screen.queryByRole("button", { name: /documents/i })).not.toBeInTheDocument();

    fireEvent.click(project);

    expect(mocks.palette.setQuery).toHaveBeenCalledWith("~/Projects/");
  });

  it("registers usable keyboard actions for an exact directory and ascends to its parent", async () => {
    mocks.palette.query = "~/projects/";

    render(<BrowseView />);

    await waitFor(() => expect(mocks.getPendingConfirm()).toEqual(expect.any(Function)));
    await waitFor(() => expect(mocks.getPendingBack()).toEqual(expect.any(Function)));

    mocks.getPendingBack()?.();

    expect(mocks.palette.setQuery).toHaveBeenCalledWith("/home/");
  });

  it("roots a bare selected drive before returning to browse mode", async () => {
    mocks.palette.query = "/";
    mocks.filesystemBrowse.mockResolvedValue({
      path: "/",
      parent: null,
      entries: [{ name: "C:", isDir: true }],
      isExactDirectory: true,
    });

    render(<BrowseView />);

    fireEvent.click(await screen.findByRole("button", { name: /c:/i }));

    expect(mocks.palette.setQuery).toHaveBeenCalledWith("C:\\");
    expect(mocks.getPendingConfirm()).toBeNull();
    expect(mocks.getPendingBack()).toBeNull();
  });
});
