/** Directory node in the pull request Change stack. */
export interface PullRequestFileTreeDirectory {
  id: string;
  kind: "directory";
  name: string;
  path: string;
  parentId: string | null;
  children: PullRequestFileTreeNode[];
}

/** File node in the pull request Change stack. */
export interface PullRequestFileTreeFile {
  id: string;
  kind: "file";
  name: string;
  path: string;
  parentId: string | null;
}

/** One directory or file in the pull request Change stack. */
export type PullRequestFileTreeNode =
  | PullRequestFileTreeDirectory
  | PullRequestFileTreeFile;

/** Visible tree row with accessible hierarchy metadata. */
export interface PullRequestFileTreeRow {
  node: PullRequestFileTreeNode;
  depth: number;
  positionInSet: number;
  setSize: number;
}

interface MutableDirectory {
  id: string;
  kind: "directory";
  name: string;
  path: string;
  parentId: string | null;
  children: Map<string, MutableDirectory | PullRequestFileTreeFile>;
}

function directoryId(path: string): string {
  return `directory:${path}`;
}

function fileId(path: string): string {
  return `file:${path}`;
}

function compareNodes(
  left: MutableDirectory | PullRequestFileTreeFile,
  right: MutableDirectory | PullRequestFileTreeFile,
): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function freezeDirectory(directory: MutableDirectory): PullRequestFileTreeDirectory {
  const children = [...directory.children.values()]
    .sort(compareNodes)
    .map((child) =>
      child.kind === "directory" ? freezeDirectory(child) : child,
    );
  return { ...directory, children };
}

function compactDirectory(
  directory: PullRequestFileTreeDirectory,
): PullRequestFileTreeDirectory {
  let compacted = directory;
  while (
    compacted.children.length === 1 &&
    compacted.children[0]?.kind === "directory"
  ) {
    const child = compacted.children[0];
    compacted = {
      ...child,
      name: `${compacted.name}/${child.name}`,
      parentId: directory.parentId,
    };
  }
  return {
    ...compacted,
    children: compacted.children.map((child) =>
      child.kind === "directory" ? compactDirectory(child) : child,
    ),
  };
}

function createRootDirectory(): MutableDirectory {
  return {
    id: directoryId(""),
    kind: "directory",
    name: "",
    path: "",
    parentId: null,
    children: new Map(),
  };
}

function directoryForSegments(
  root: MutableDirectory,
  segments: readonly string[],
): MutableDirectory {
  let parent = root;
  for (const [index, name] of segments.slice(0, -1).entries()) {
    const path = segments.slice(0, index + 1).join("/");
    const id = directoryId(path);
    const existing = parent.children.get(id);
    if (existing?.kind === "directory") {
      parent = existing;
      continue;
    }
    const directory: MutableDirectory = {
      id,
      kind: "directory",
      name,
      path,
      parentId: parent === root ? null : parent.id,
      children: new Map(),
    };
    parent.children.set(id, directory);
    parent = directory;
  }
  return parent;
}

function insertFilePath(root: MutableDirectory, filePath: string): void {
  const segments = filePath.split("/").filter(Boolean);
  if (segments.length === 0) return;
  const parent = directoryForSegments(root, segments);
  const name = segments[segments.length - 1]!;
  parent.children.set(fileId(filePath), {
    id: fileId(filePath),
    kind: "file",
    name,
    path: filePath,
    parentId: parent === root ? null : parent.id,
  });
}

/** Build a deterministic directory tree from bounded provider file paths. */
export function buildPullRequestFileTree(
  filePaths: readonly string[],
): PullRequestFileTreeNode[] {
  const root = createRootDirectory();
  for (const filePath of new Set(filePaths)) insertFilePath(root, filePath);

  return [...root.children.values()]
    .sort(compareNodes)
    .map((child) =>
      child.kind === "directory"
        ? compactDirectory(freezeDirectory(child))
        : child,
    );
}

/** Flatten expanded tree nodes into one virtualizable row sequence. */
export function flattenPullRequestFileTree(
  roots: readonly PullRequestFileTreeNode[],
  expandedDirectoryIds: ReadonlySet<string>,
  expandAll = false,
): PullRequestFileTreeRow[] {
  const rows: PullRequestFileTreeRow[] = [];
  const visit = (
    nodes: readonly PullRequestFileTreeNode[],
    depth: number,
  ): void => {
    nodes.forEach((node, index) => {
      rows.push({
        node,
        depth,
        positionInSet: index + 1,
        setSize: nodes.length,
      });
      if (
        node.kind === "directory" &&
        (expandAll || expandedDirectoryIds.has(node.id))
      ) {
        visit(node.children, depth + 1);
      }
    });
  };
  visit(roots, 1);
  return rows;
}

/** Return every directory identifier in a built pull request file tree. */
export function collectPullRequestDirectoryIds(
  roots: readonly PullRequestFileTreeNode[],
): string[] {
  const ids: string[] = [];
  const visit = (nodes: readonly PullRequestFileTreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind !== "directory") continue;
      ids.push(node.id);
      visit(node.children);
    }
  };
  visit(roots);
  return ids;
}
