/** IDs of editors we detect and can spawn. Mirrors EDITOR_CONFIGS in open-in/index.ts. */
export type EditorId = "code" | "cursor" | "zed" | "vs";

/**
 * Build the CLI arguments to pass to an editor's executable, given a target
 * path and an optional line to jump to. Pure function — easy to unit-test.
 *
 * VS Code and Cursor share the `-g <path>:<line>` goto-mode syntax (Cursor is
 * a VS Code fork). Zed accepts `<path>:<line>` natively without a flag. Visual
 * Studio's `devenv` CLI has no folder-mode goto-line flag, so it always opens
 * the path as-is.
 *
 * A non-positive or non-finite line is treated as "no line" so callers can
 * defensively forward whatever they parsed without bookkeeping.
 */
export function buildEditorArgs(
  editor: EditorId,
  path: string,
  line?: number,
): string[] {
  const lineIsUsable = typeof line === "number" && Number.isFinite(line) && line > 0;
  if (!lineIsUsable || editor === "vs") return [path];

  const target = `${path}:${line}`;
  if (editor === "zed") return [target];
  return ["-g", target];
}
