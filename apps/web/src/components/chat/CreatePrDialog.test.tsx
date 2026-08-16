import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { GitBranch } from "@mcode/contracts";

const { mockLoadBranches, mockWorkspaceState, mockGeneratePrDraft } = vi.hoisted(() => ({
  mockLoadBranches: vi.fn(),
  mockGeneratePrDraft: vi.fn().mockResolvedValue({ title: "Draft title", body: "Draft body" }),
  mockWorkspaceState: {
    branches: [
      { name: "feat/issue-801", type: "local", isCurrent: true },
      { name: "main", type: "local", isCurrent: false },
      { name: "release", type: "local", isCurrent: false },
    ] as GitBranch[],
    branchesLoading: false,
  },
}));

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      ...mockWorkspaceState,
      loadBranches: mockLoadBranches,
    }),
  ),
}));

vi.mock("@/stores/toastStore", () => ({
  useToastStore: {
    getState: vi.fn(() => ({ show: vi.fn() })),
  },
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({
    createPr: vi.fn(),
    generatePrDraft: mockGeneratePrDraft,
  }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ render }: { render: ReactElement }) => render,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/command", () => ({
  Command: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandInput: ({ placeholder }: { placeholder?: string }) => (
    <input aria-label={placeholder ?? "Search"} />
  ),
  CommandItem: ({
    children,
    onSelect,
    value,
  }: {
    children: ReactNode;
    onSelect: (value: string) => void;
    value: string;
  }) => (
    <button type="button" onClick={() => onSelect(value)}>
      {children}
    </button>
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./MarkdownContent", () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { CreatePrDialog } from "./CreatePrDialog";

describe("CreatePrDialog preferred base branch", () => {
  it("uses the preferred base initially without overriding later user selection", async () => {
    render(
      <CreatePrDialog
        open
        onOpenChange={vi.fn()}
        threadId="thread-1"
        workspaceId="ws-1"
        branch="feat/issue-801"
        preferredBaseBranch="main"
      />,
    );

    const basePicker = screen.getByRole("button", { name: "Base branch" });
    expect(basePicker).toHaveTextContent("main");

    fireEvent.click(screen.getByRole("button", { name: /release/ }));

    await waitFor(() => {
      expect(basePicker).toHaveTextContent("release");
    });
  });

  it("generates an initial draft when the dialog opens with an empty form", async () => {
    mockGeneratePrDraft.mockClear();
    render(
      <CreatePrDialog
        open
        onOpenChange={vi.fn()}
        threadId="thread-1"
        workspaceId="ws-1"
        branch="feat/issue-801"
        preferredBaseBranch="main"
      />,
    );

    await waitFor(() => {
      expect(mockGeneratePrDraft).toHaveBeenCalledWith("ws-1", "thread-1", "main");
    });
    expect(await screen.findByDisplayValue("Draft title")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Draft body")).toBeInTheDocument();
  });

  it("announces draft generation status while the initial draft is loading", async () => {
    mockGeneratePrDraft.mockImplementation(() => new Promise(() => {}));
    render(
      <CreatePrDialog
        open
        onOpenChange={vi.fn()}
        threadId="thread-1"
        workspaceId="ws-1"
        branch="feat/issue-801"
        preferredBaseBranch="main"
      />,
    );

    const status = await screen.findByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Generating PR draft");
  });
});
