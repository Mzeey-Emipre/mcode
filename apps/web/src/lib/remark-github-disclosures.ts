import type { Blockquote, Paragraph, Root, RootContent, Text } from "mdast";

const DISCLOSURE_OPEN =
  /^<details(\s+open)?>\s*\n?<summary>([\s\S]{1,512})<\/summary>\s*$/i;
const DISCLOSURE_CLOSE = /^\s*<\/details>\s*$/i;

type HtmlNode = Extract<RootContent, { type: "html" }>;

function isHtmlNode(node: RootContent): node is HtmlNode {
  return node.type === "html";
}

function summaryText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function disclosureNode(
  label: string,
  children: RootContent[],
  open: boolean,
): Blockquote {
  const summary: Paragraph = {
    type: "paragraph",
    children: [{ type: "text", value: label } as Text],
    data: { hName: "summary" },
  };

  return {
    type: "blockquote",
    children: [summary, ...children] as Blockquote["children"],
    data: {
      hName: "details",
      hProperties: {
        "data-github-disclosure": "",
        ...(open ? { open: true } : {}),
      },
    },
  };
}

function findClosingDisclosureIndex(children: RootContent[], startIndex: number): number {
  let depth = 1;
  for (let cursor = startIndex + 1; cursor < children.length; cursor += 1) {
    const candidate = children[cursor];
    if (!candidate || !isHtmlNode(candidate)) continue;
    if (DISCLOSURE_OPEN.test(candidate.value)) depth += 1;
    if (!DISCLOSURE_CLOSE.test(candidate.value)) continue;
    depth -= 1;
    if (depth === 0) return cursor;
  }
  return -1;
}

function transformBlockquote(node: RootContent): void {
  if (node.type === "blockquote") {
    node.children = transformChildren(node.children as RootContent[]) as Blockquote["children"];
  }
}

function createDisclosure(
  children: RootContent[],
  index: number,
  node: HtmlNode,
): { closingIndex: number; disclosure: Blockquote } | undefined {
  const opening = DISCLOSURE_OPEN.exec(node.value);
  const label = opening?.[2] ? summaryText(opening[2]) : "";
  const closingIndex = findClosingDisclosureIndex(children, index);
  if (closingIndex < 0 || !label) return undefined;

  return {
    closingIndex,
    disclosure: disclosureNode(
      label,
      transformChildren(children.slice(index + 1, closingIndex)),
      Boolean(opening?.[1]),
    ),
  };
}

function transformChildren(children: RootContent[]): RootContent[] {
  const transformed: RootContent[] = [];

  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    if (!node) continue;

    transformBlockquote(node);

    if (!isHtmlNode(node)) {
      transformed.push(node);
      continue;
    }

    const disclosure = createDisclosure(children, index, node);
    if (!disclosure) {
      transformed.push(node);
      continue;
    }

    transformed.push(disclosure.disclosure);
    index = disclosure.closingIndex;
  }

  return transformed;
}

/** Converts bounded GitHub details markup into safe disclosure nodes. */
export function remarkGitHubDisclosures() {
  return (tree: Root): void => {
    tree.children = transformChildren(tree.children);
  };
}
