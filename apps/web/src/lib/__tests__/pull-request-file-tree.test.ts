import { describe, expect, it } from "vitest";
import {
  buildPullRequestFileTree,
  collectPullRequestDirectoryIds,
  flattenPullRequestFileTree,
} from "../pull-request-file-tree";

describe("pull request file tree", () => {
  it("builds stable directory-first rows and ignores duplicate paths", () => {
    const tree = buildPullRequestFileTree([
      "README.md",
      "apps/web/src/zeta.ts",
      "apps/web/src/alpha.ts",
      "apps/web/src/alpha.ts",
      "apps/server/index.ts",
    ]);
    const rows = flattenPullRequestFileTree(
      tree,
      new Set(collectPullRequestDirectoryIds(tree)),
    );

    expect(rows.map((row) => `${row.node.kind}:${row.node.path}`)).toEqual([
      "directory:apps",
      "directory:apps/server",
      "file:apps/server/index.ts",
      "directory:apps/web/src",
      "file:apps/web/src/alpha.ts",
      "file:apps/web/src/zeta.ts",
      "file:README.md",
    ]);
  });

  it("only exposes children of expanded directories", () => {
    const tree = buildPullRequestFileTree([
      "apps/web/src/App.tsx",
      "packages/contracts/src/index.ts",
    ]);
    const collapsed = flattenPullRequestFileTree(tree, new Set());
    expect(collapsed.map((row) => row.node.path)).toEqual([
      "apps/web/src",
      "packages/contracts/src",
    ]);

    const appsOpen = flattenPullRequestFileTree(
      tree,
      new Set(["directory:apps/web/src"]),
    );
    expect(appsOpen.map((row) => row.node.path)).toEqual([
      "apps/web/src",
      "apps/web/src/App.tsx",
      "packages/contracts/src",
    ]);
  });

  it("compacts a directory chain that contains no sibling files", () => {
    const tree = buildPullRequestFileTree([
      ".octopus/qualtex-launchpad/deployment_process.ocl",
      ".octopus/qualtex-launchpad/variables.ocl",
    ]);

    expect(tree).toMatchObject([
      {
        kind: "directory",
        id: "directory:.octopus/qualtex-launchpad",
        name: ".octopus/qualtex-launchpad",
        path: ".octopus/qualtex-launchpad",
      },
    ]);
  });

  it("provides one-based hierarchy metadata for a roving tree", () => {
    const tree = buildPullRequestFileTree(["a.ts", "b.ts"]);
    const rows = flattenPullRequestFileTree(tree, new Set());

    expect(rows).toMatchObject([
      { depth: 1, positionInSet: 1, setSize: 2 },
      { depth: 1, positionInSet: 2, setSize: 2 },
    ]);
  });
});
