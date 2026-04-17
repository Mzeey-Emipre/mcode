/**
 * Builds a folder/file tree from a flat list of paths.
 * Used by the diff views to render changed files as a navigable tree
 * instead of a flat path list.
 *
 * Single-child folder chains are compressed into a single segment label
 * (matching VS Code's "compact folders" behavior). Folders sort before
 * files; both alphabetical within their group.
 */

/** A leaf file in the tree. */
export interface FileNode {
  type: "file";
  /** Display label — basename only. */
  name: string;
  /** Full path from the original input, used as the diff key. */
  path: string;
}

/** A folder node containing one or more children. */
export interface FolderNode {
  type: "folder";
  /** Display label — possibly compressed (e.g., "src/stores/__tests__"). */
  name: string;
  /** Full directory path from the root. */
  path: string;
  /** Total file count in this subtree (recursive). Useful for headers. */
  fileCount: number;
  children: TreeNode[];
}

export type TreeNode = FileNode | FolderNode;

/** Internal trie used during construction. */
interface TrieNode {
  children: Map<string, TrieNode>;
  files: string[];
}

/**
 * Builds a navigable tree from `paths`.
 * Empty input returns an empty array.
 *
 * Folders with exactly one child folder and no files are compressed:
 * `src/stores/__tests__/foo.ts` → folder `src/stores/__tests__` with file `foo.ts`.
 */
export function buildFileTree(paths: readonly string[]): TreeNode[] {
  const root: TrieNode = { children: new Map(), files: [] };

  for (const path of paths) {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    const fileName = segments.pop()!;
    let node = root;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map(), files: [] };
        node.children.set(segment, child);
      }
      node = child;
    }
    // Store the original path on the leaf so file lookups stay stable.
    node.files.push(path);
    // Track the basename separately by reusing the files array; the basename
    // is recoverable from the path itself when rendering.
    void fileName;
  }

  return materialize(root, "");
}

/** Recursively walks the trie and produces sorted, compressed TreeNodes. */
function materialize(node: TrieNode, parentPath: string): TreeNode[] {
  const folders: FolderNode[] = [];

  for (const [childName, childNode] of node.children) {
    // Compress single-child folder chains: while this folder has exactly
    // one child folder and zero files, merge the child's name into the label.
    let displayName = childName;
    let current = childNode;
    while (current.files.length === 0 && current.children.size === 1) {
      const entry = current.children.entries().next().value;
      if (!entry) break;
      const [onlyName, onlyChild] = entry;
      displayName = `${displayName}/${onlyName}`;
      current = onlyChild;
    }

    const folderPath = parentPath ? `${parentPath}/${displayName}` : displayName;
    const children = materialize(current, folderPath);
    folders.push({
      type: "folder",
      name: displayName,
      path: folderPath,
      fileCount: countFiles(children),
      children,
    });
  }

  const files: FileNode[] = node.files.map((path) => ({
    type: "file",
    name: path.split("/").pop() ?? path,
    path,
  }));

  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return [...folders, ...files];
}

/** Recursively counts files in a list of tree nodes. */
function countFiles(nodes: TreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === "file") count++;
    else count += node.fileCount;
  }
  return count;
}
