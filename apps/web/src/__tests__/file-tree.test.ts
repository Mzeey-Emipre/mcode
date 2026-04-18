import { describe, it, expect } from "vitest";
import { buildFileTree } from "@/lib/file-tree";

describe("buildFileTree", () => {
  it("returns an empty array for empty input", () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it("returns root files as flat file nodes (alphabetically sorted)", () => {
    const tree = buildFileTree(["README.md", "package.json"]);
    // localeCompare is case-insensitive in the default locale: package.json < README.md
    expect(tree).toEqual([
      { type: "file", name: "package.json", path: "package.json" },
      { type: "file", name: "README.md", path: "README.md" },
    ]);
  });

  it("sorts root files alphabetically", () => {
    const tree = buildFileTree(["zeta.ts", "alpha.ts"]);
    expect(tree.map((n) => n.name)).toEqual(["alpha.ts", "zeta.ts"]);
  });

  it("groups files under a folder", () => {
    const tree = buildFileTree(["src/foo.ts", "src/bar.ts"]);
    expect(tree).toHaveLength(1);
    const folder = tree[0];
    expect(folder.type).toBe("folder");
    if (folder.type !== "folder") return;
    expect(folder.name).toBe("src");
    expect(folder.path).toBe("src");
    expect(folder.fileCount).toBe(2);
    expect(folder.children.map((c) => c.name)).toEqual(["bar.ts", "foo.ts"]);
  });

  it("compresses single-child folder chains", () => {
    const tree = buildFileTree(["src/stores/__tests__/notifications.spec.ts"]);
    expect(tree).toHaveLength(1);
    const folder = tree[0];
    expect(folder.type).toBe("folder");
    if (folder.type !== "folder") return;
    expect(folder.name).toBe("src/stores/__tests__");
    expect(folder.fileCount).toBe(1);
    expect(folder.children).toEqual([
      {
        type: "file",
        name: "notifications.spec.ts",
        path: "src/stores/__tests__/notifications.spec.ts",
      },
    ]);
  });

  it("does not compress past a folder that has multiple children", () => {
    const tree = buildFileTree([
      "src/stores/foo.ts",
      "src/stores/bar.ts",
      "src/components/x.tsx",
    ]);
    // Root has only "src" as a single child — compression stops at "src" because
    // src itself has two child folders.
    expect(tree).toHaveLength(1);
    const root = tree[0];
    expect(root.type).toBe("folder");
    if (root.type !== "folder") return;
    expect(root.name).toBe("src");
    expect(root.children).toHaveLength(2);
    const componentsFolder = root.children[0];
    const storesFolder = root.children[1];
    expect(componentsFolder.name).toBe("components");
    expect(storesFolder.name).toBe("stores");
  });

  it("places folders before files at the same level", () => {
    const tree = buildFileTree(["zeta.ts", "src/foo.ts"]);
    expect(tree.map((n) => n.type)).toEqual(["folder", "file"]);
  });

  it("computes fileCount recursively", () => {
    const tree = buildFileTree([
      "src/a.ts",
      "src/b.ts",
      "src/nested/c.ts",
      "src/nested/d.ts",
    ]);
    expect(tree).toHaveLength(1);
    const root = tree[0];
    if (root.type !== "folder") return;
    expect(root.fileCount).toBe(4);
  });

  it("does not compress a folder that contains both a subfolder and a file", () => {
    const tree = buildFileTree(["src/foo.ts", "src/nested/bar.ts"]);
    const root = tree[0];
    expect(root.type).toBe("folder");
    if (root.type !== "folder") throw new Error("root must be a folder");
    expect(root.name).toBe("src");
    expect(root.children.map((c) => c.name)).toEqual(["nested", "foo.ts"]);
  });

  it("preserves the original path on file leaves for diff lookups", () => {
    const tree = buildFileTree(["src/stores/__tests__/foo.ts"]);
    const folder = tree[0];
    expect(folder.type).toBe("folder");
    if (folder.type !== "folder") throw new Error("folder must be a folder");
    const file = folder.children[0];
    expect(file.type).toBe("file");
    if (file.type !== "file") throw new Error("file must be a file");
    expect(file.path).toBe("src/stores/__tests__/foo.ts");
  });

  it("ignores empty paths", () => {
    expect(buildFileTree([""])).toEqual([]);
  });
});
