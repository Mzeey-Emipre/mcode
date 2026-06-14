import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileSearch } from "lucide-react";
import { FileEntry } from "./FileEntry";
import { FolderEntry } from "./FolderEntry";
import { buildFileTree, type TreeNode } from "@/lib/file-tree";
import type { SelectedFile } from "@/stores/diffStore";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Props for FileList. */
interface FileListProps {
  files: string[];
  source: SelectedFile["source"];
  id: string;
  /** Thread that owns these files, used to scope the inline diff cache. */
  threadId: string;
  /** When true every file entry starts expanded (used for the latest turn). */
  defaultFilesExpanded?: boolean;
  /** Extra identity for mutable comparisons whose ref names can stay stable while content changes. */
  cacheVersion?: string | number;
}

/**
 * Renders a list of changed files as a navigable folder tree.
 * Single-child folder chains are compressed (e.g., `src/stores/__tests__/`).
 * Folders sort before files; both alphabetical within their group.
 */
export function FileList({
  files,
  source,
  id,
  threadId,
  defaultFilesExpanded = false,
  cacheVersion = 0,
}: FileListProps) {
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpTarget, setJumpTarget] = useState<{ path: string; token: number } | null>(null);
  const [highlightTarget, setHighlightTarget] = useState<{ path: string; token: number } | null>(null);
  const jumpTokenRef = useRef(0);
  const highlightClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tree = useMemo(() => buildFileTree(files), [files]);

  useEffect(() => {
    return () => {
      if (highlightClearRef.current) clearTimeout(highlightClearRef.current);
    };
  }, []);

  const jumpToFile = useCallback((path: string) => {
    const token = ++jumpTokenRef.current;
    setJumpOpen(false);
    setJumpTarget({ path, token });
    setHighlightTarget({ path, token });

    if (highlightClearRef.current) clearTimeout(highlightClearRef.current);
    highlightClearRef.current = setTimeout(() => {
      setHighlightTarget((current) => (current?.token === token ? null : current));
      highlightClearRef.current = null;
    }, 1500);
  }, []);

  const clearJumpTarget = useCallback((token: number) => {
    setJumpTarget((current) => (current?.token === token ? null : current));
  }, []);

  if (files.length === 0) {
    return (
      <p className="px-3 py-1 text-[11px] text-muted-foreground/40">No files changed</p>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-border/20 bg-background/95 px-3 py-2 backdrop-blur-sm">
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/50">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <Popover open={jumpOpen} onOpenChange={setJumpOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label="Jump to file"
                data-testid="review-file-jump-trigger"
                className="h-6 gap-1.5 border border-border/20 bg-muted/10 px-2 font-mono text-[10.5px] text-muted-foreground/75 hover:border-border/35 hover:bg-muted/25 hover:text-foreground"
              >
                <FileSearch size={12} aria-hidden="true" />
                Jump
              </Button>
            }
          />
          <PopoverContent align="end" sideOffset={6} className="w-[min(360px,calc(100vw-2rem))] p-0">
            <Command className="rounded-lg">
              <CommandInput
                autoFocus
                placeholder="Jump to file"
                aria-label="Jump to file"
                data-testid="review-file-filter"
                className="h-9 font-mono text-[11px]"
              />
              <CommandList className="max-h-72">
                <CommandEmpty>No files found</CommandEmpty>
                <CommandGroup heading="Changed files">
                  {files.map((file) => {
                    const basename = getFileBasename(file);
                    const parent = getParentPath(file);
                    return (
                      <CommandItem
                        key={file}
                        value={file}
                        data-testid={`review-file-jump-item-${file}`}
                        onSelect={() => jumpToFile(file)}
                        className="items-start gap-2 px-2 py-2"
                      >
                        <FileSearch
                          size={12}
                          aria-hidden="true"
                          className="mt-0.5 text-muted-foreground/45"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-[11.5px] text-foreground/85">
                            {basename}
                          </span>
                          {parent && (
                            <span className="block truncate font-mono text-[10px] text-muted-foreground/55">
                              {parent}/
                            </span>
                          )}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      {tree.map((node) => (
        <TreeNodeRenderer
          key={nodeKey(node)}
          node={node}
          depth={0}
          source={source}
          id={id}
          threadId={threadId}
          defaultExpanded={defaultFilesExpanded}
          cacheVersion={cacheVersion}
          jumpTarget={jumpTarget}
          highlightTarget={highlightTarget}
          onJumpSettled={clearJumpTarget}
        />
      ))}
    </div>
  );
}

/** Stable key for a tree node. Folders use their full path, files use the file path. */
function nodeKey(node: TreeNode): string {
  return node.type === "folder" ? `dir:${node.path}` : `file:${node.path}`;
}

/** Recursively renders a folder or file node with the appropriate depth indent. */
function TreeNodeRenderer({
  node,
  depth,
  source,
  id,
  threadId,
  defaultExpanded,
  cacheVersion,
  jumpTarget,
  highlightTarget,
  onJumpSettled,
}: {
  node: TreeNode;
  depth: number;
  source: SelectedFile["source"];
  id: string;
  threadId: string;
  defaultExpanded?: boolean;
  cacheVersion: string | number;
  jumpTarget: { path: string; token: number } | null;
  highlightTarget: { path: string; token: number } | null;
  onJumpSettled: (token: number) => void;
}) {
  if (node.type === "file") {
    return (
      <FileEntry
        filePath={node.path}
        source={source}
        id={id}
        threadId={threadId}
        depth={depth}
        defaultExpanded={defaultExpanded}
        cacheVersion={cacheVersion}
        jumpToken={jumpTarget?.path === node.path ? jumpTarget.token : undefined}
        onJumpSettled={onJumpSettled}
        highlightToken={highlightTarget?.path === node.path ? highlightTarget.token : undefined}
      />
    );
  }

  return (
    <FolderEntry
      name={node.name}
      fileCount={node.fileCount}
      depth={depth}
      forceExpanded={jumpTarget ? treeContainsPath(node, jumpTarget.path) : false}
    >
      {node.children.map((child) => (
        <TreeNodeRenderer
          key={nodeKey(child)}
          node={child}
          depth={depth + 1}
          source={source}
          id={id}
          threadId={threadId}
          defaultExpanded={defaultExpanded}
          cacheVersion={cacheVersion}
          jumpTarget={jumpTarget}
          highlightTarget={highlightTarget}
          onJumpSettled={onJumpSettled}
        />
      ))}
    </FolderEntry>
  );
}

/** Whether a tree node contains a given file path. */
function treeContainsPath(node: TreeNode, path: string): boolean {
  if (node.type === "file") return node.path === path;
  return node.children.some((child) => treeContainsPath(child, path));
}

/** Extract the basename from a file path for jump result labels. */
function getFileBasename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

/** Extract the parent path from a file path for jump result labels. */
function getParentPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}
