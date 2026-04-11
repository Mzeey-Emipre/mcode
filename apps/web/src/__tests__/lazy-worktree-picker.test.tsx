import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("cmdk", () => ({
  Command: Object.assign(
    ({ children, ...props }: any) => <div {...props}>{children}</div>,
    {
      Input: (props: any) => <input {...props} />,
      List: ({ children, ...props }: any) => <div {...props}>{children}</div>,
      Empty: ({ children, ...props }: any) => <div {...props}>{children}</div>,
      Group: ({ children, ...props }: any) => <div {...props}>{children}</div>,
      Item: ({ children, ...props }: any) => <div {...props}>{children}</div>,
      Separator: (props: any) => <hr {...props} />,
    },
  ),
}));

import { WorktreePicker } from "../components/chat/WorktreePicker";

const worktrees = [
  { name: "feature-a", branch: "feature/a", path: "/repo/.worktrees/feature-a", managed: true },
];

describe("WorktreePicker", () => {
  it("renders the selected worktree name", () => {
    render(
      <WorktreePicker
        worktrees={worktrees}
        selectedPath="/repo/.worktrees/feature-a"
        onSelect={() => {}}
        loading={false}
      />,
    );
    expect(screen.getByText("feature-a")).toBeInTheDocument();
  });
});
