/**
 * Lexical DecoratorNode for @file mention chips.
 *
 * Renders an inline chip with a VSCode file icon and the file basename.
 * Serializes as `@<filePath>` for plain-text extraction.
 */
import { type JSX, useEffect, useState } from "react";
import {
  DecoratorNode,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
} from "lexical";
import { resolveIcon, type ResolvedIcon } from "@/lib/vscode-icons";

// ---------------------------------------------------------------------------
// Serialized shape
// ---------------------------------------------------------------------------

export interface SerializedMentionNode extends SerializedLexicalNode {
  readonly type: "mention";
  readonly filePath: string;
}

// ---------------------------------------------------------------------------
// MentionChip (React component rendered by decorate())
// ---------------------------------------------------------------------------

const CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-md border bg-sky-500/20 ring-1 ring-sky-500/30 px-1.5 py-0.5 text-xs align-baseline";

function basename(filePath: string): string {
  const sep = filePath.lastIndexOf("/");
  return sep === -1 ? filePath : filePath.slice(sep + 1);
}

function MentionChip({ filePath }: { readonly filePath: string }): JSX.Element {
  const name = basename(filePath);
  const [icon, setIcon] = useState<ResolvedIcon | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveIcon(name)
      .then((resolved) => {
        if (!cancelled) setIcon(resolved);
      })
      .catch(() => {
        // Icon resolution failed; chip renders without icon
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  return (
    <span className={CHIP_CLASS}>
      {icon?.type === "vscode" ? (
        <img src={icon.url} alt="" className="size-3.5" />
      ) : icon?.type === "lucide" ? (
        <icon.icon className="size-3.5 text-sky-400/70" />
      ) : (
        <span className="size-3.5" />
      )}
      {name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// MentionNode (Lexical DecoratorNode)
// ---------------------------------------------------------------------------

export class MentionNode extends DecoratorNode<JSX.Element> {
  __filePath: string;

  static getType(): string {
    return "mention";
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__filePath, node.__key);
  }

  constructor(filePath: string, key?: NodeKey) {
    super(key);
    this.__filePath = filePath;
  }

  // -- Accessors ------------------------------------------------------------

  getFilePath(): string {
    return this.getLatest().__filePath;
  }

  // -- Behavior -------------------------------------------------------------

  isInline(): boolean {
    return true;
  }

  getTextContent(): string {
    return `@${this.__filePath}`;
  }

  // -- DOM ------------------------------------------------------------------

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.style.display = "inline";
    return span;
  }

  updateDOM(): false {
    return false;
  }

  // -- Serialization --------------------------------------------------------

  exportJSON(): SerializedMentionNode {
    return {
      type: "mention",
      filePath: this.__filePath,
      version: 1,
    };
  }

  static importJSON(serializedNode: SerializedMentionNode): MentionNode {
    return $createMentionNode(serializedNode.filePath);
  }

  // -- Decoration -----------------------------------------------------------

  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return <MentionChip filePath={this.__filePath} />;
  }
}

// ---------------------------------------------------------------------------
// Helper exports
// ---------------------------------------------------------------------------

export function $createMentionNode(filePath: string): MentionNode {
  return new MentionNode(filePath);
}

export function $isMentionNode(
  node: LexicalNode | null | undefined,
): node is MentionNode {
  return node instanceof MentionNode;
}
