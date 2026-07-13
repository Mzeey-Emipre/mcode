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

function transformChildren(children: RootContent[]): RootContent[] {
  const transformed: RootContent[] = [];

  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    if (!node) continue;

    if (node.type === "blockquote") {
      node.children = transformChildren(
        node.children as RootContent[],
      ) as Blockquote["children"];
    }

    if (!isHtmlNode(node)) {
      transformed.push(node);
      continue;
    }

    const opening = DISCLOSURE_OPEN.exec(node.value);
    if (!opening?.[2]) {
      transformed.push(node);
      continue;
    }

    let depth = 1;
    let closingIndex = -1;
    for (let cursor = index + 1; cursor < children.length; cursor += 1) {
      const candidate = children[cursor];
      if (!candidate || !isHtmlNode(candidate)) continue;
      if (DISCLOSURE_OPEN.test(candidate.value)) depth += 1;
      if (!DISCLOSURE_CLOSE.test(candidate.value)) continue;
      depth -= 1;
      if (depth === 0) {
        closingIndex = cursor;
        break;
      }
    }

    const label = summaryText(opening[2]);
    if (closingIndex < 0 || !label) {
      transformed.push(node);
      continue;
    }

    const contents = transformChildren(children.slice(index + 1, closingIndex));
    transformed.push(disclosureNode(label, contents, Boolean(opening[1])));
    index = closingIndex;
  }

  return transformed;
}

/** Converts bounded GitHub details markup into safe disclosure nodes. */
export function remarkGitHubDisclosures() {
  return (tree: Root): void => {
    tree.children = transformChildren(tree.children);
  };
}
