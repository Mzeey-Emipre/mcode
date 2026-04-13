import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { lazy, Suspense, type ComponentProps } from "react";

vi.mock("cmdk", () => ({
  Command: Object.assign(
    ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
    {
      Input: (props: ComponentProps<"input">) => <input {...props} />,
      List: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
      Empty: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
      Group: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
      Item: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
      Separator: (props: ComponentProps<"hr">) => <hr {...props} />,
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

  it("renders via React.lazy default export", async () => {
    const LazyWorktreePicker = lazy(() => import("../components/chat/WorktreePicker"));
    render(
      <Suspense fallback={<div data-testid="fallback" />}>
        <LazyWorktreePicker
          worktrees={worktrees}
          selectedPath="/repo/.worktrees/feature-a"
          onSelect={() => {}}
          loading={false}
        />
      </Suspense>,
    );
    expect(await screen.findByText("feature-a")).toBeInTheDocument();
  });
});
