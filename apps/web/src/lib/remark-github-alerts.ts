import type { Blockquote, Root, RootContent, Text } from "mdast";

/** GitHub alert variants supported in remote Markdown. */
export type GitHubAlertKind =
  | "note"
  | "tip"
  | "important"
  | "warning"
  | "caution";

const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

function markGitHubAlert(node: Blockquote): void {
  const paragraph = node.children[0];
  if (paragraph?.type !== "paragraph") return;
  const firstChild = paragraph.children[0];
  if (firstChild?.type !== "text") return;
  const match = ALERT_MARKER.exec(firstChild.value);
  if (!match?.[1]) return;

  const kind = match[1].toLowerCase() as GitHubAlertKind;
  (firstChild as Text).value = firstChild.value.slice(match[0].length);
  const withData = node as Blockquote & {
    data?: { hProperties?: Record<string, unknown> };
  };
  withData.data = withData.data ?? {};
  withData.data.hProperties = withData.data.hProperties ?? {};
  withData.data.hProperties["data-github-alert"] = kind;
}

function visit(node: Root | RootContent): void {
  if (node.type === "blockquote") markGitHubAlert(node);
  if (!("children" in node) || !Array.isArray(node.children)) return;
  for (const child of node.children) visit(child as RootContent);
}

/** Converts GitHub alert blockquotes into typed, marker-free render nodes. */
export function remarkGitHubAlerts() {
  return (tree: Root): void => visit(tree);
}
