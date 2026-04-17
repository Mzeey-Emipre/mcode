import { useMemo } from "react";
import { FileEntry } from "./FileEntry";
import { FolderEntry } from "./FolderEntry";
import { buildFileTree, type TreeNode } from "@/lib/file-tree";
import type { SelectedFile } from "@/stores/diffStore";

/** Props for FileList. */
interface FileListProps {
  files: string[];
  source: SelectedFile["source"];
  id: string;
}

/**
 * Renders a list of changed files as a navigable folder tree.
 * Single-child folder chains are compressed (e.g., `src/stores/__tests__/`).
 * Folders sort before files; both alphabetical within their group.
 */
export function FileList({ files, source, id }: FileListProps) {
  const tree = useMemo(() => buildFileTree(files), [files]);

  if (files.length === 0) {
    return (
      <p className="px-3 py-1 text-[11px] text-muted-foreground/40">No files changed</p>
    );
  }

  return (
    <div className="flex flex-col">
      {tree.map((node) => (
        <TreeNodeRenderer key={nodeKey(node)} node={node} depth={0} source={source} id={id} />
      ))}
    </div>
  );
}

/** Stable key for a tree node — folders use their full path, files use the file path. */
function nodeKey(node: TreeNode): string {
  return node.type === "folder" ? `dir:${node.path}` : `file:${node.path}`;
}

/** Recursively renders a folder or file node with the appropriate depth indent. */
function TreeNodeRenderer({
  node,
  depth,
  source,
  id,
}: {
  node: TreeNode;
  depth: number;
  source: SelectedFile["source"];
  id: string;
}) {
  if (node.type === "file") {
    // depth 0 = file at the root of the input (no folder above it) → render flat.
    // depth > 0 = file inside a folder → render nested (suppress redundant parent path).
    return <FileEntry filePath={node.path} source={source} id={id} depth={depth} />;
  }

  return (
    <FolderEntry name={node.name} fileCount={node.fileCount} depth={depth}>
      {node.children.map((child) => (
        <TreeNodeRenderer
          key={nodeKey(child)}
          node={child}
          depth={depth + 1}
          source={source}
          id={id}
        />
      ))}
    </FolderEntry>
  );
}
