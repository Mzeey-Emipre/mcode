import type { PullRequestFile } from "@mcode/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PullRequestChangedFilesPane } from "../PullRequestChangedFilesPane";

const file: PullRequestFile = {
  locator: "file_1",
  path: "apps/web/src/App.tsx",
  previousPath: null,
  changeType: "modified",
  additions: 2,
  deletions: 1,
  changes: 3,
  blobOid: "a".repeat(40),
  patchStatus: "available",
};

describe("PullRequestChangedFilesPane", () => {
  it("keeps file controls and the tree inside one navigator", () => {
    render(
      <PullRequestChangedFilesPane
        files={[file]}
        activePath={file.path}
        query={{ search: "", changeTypes: [] }}
        onActivate={vi.fn()}
        onQueryChange={vi.fn()}
      />,
    );

    const navigator = screen.getByTestId("pull-request-changed-files-pane");
    expect(navigator).toContainElement(
      within(navigator).getByRole("textbox", { name: "Search changed files" }),
    );
    expect(navigator).toContainElement(
      within(navigator).getByRole("tree", {
        name: "Pull request changed files",
      }),
    );
  });

  it("owns debounced search without a second filter control", async () => {
    const onQueryChange = vi.fn();
    render(
      <PullRequestChangedFilesPane
        files={[file]}
        activePath={file.path}
        query={{ search: "", changeTypes: [] }}
        onActivate={vi.fn()}
        onQueryChange={onQueryChange}
      />,
    );

    await userEvent.type(
      screen.getByRole("textbox", { name: "Search changed files" }),
      "store",
    );
    await waitFor(() =>
      expect(onQueryChange).toHaveBeenCalledWith({
        search: "store",
        changeTypes: [],
      }),
    );
    expect(
      screen.queryByRole("button", {
        name: "Filter changed files by status",
      }),
    ).not.toBeInTheDocument();
  });
});
