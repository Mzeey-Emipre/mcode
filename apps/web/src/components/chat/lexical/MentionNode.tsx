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
import type { MessageMention } from "@mcode/contracts";
import { resolveIcon, type ResolvedIcon } from "@/lib/vscode-icons";
import { basename } from "@/lib/path";

// ---------------------------------------------------------------------------
// Serialized shape
// ---------------------------------------------------------------------------

/** JSON-serialized form of a MentionNode for editor state persistence. */
export interface SerializedMentionNode extends SerializedLexicalNode {
  readonly type: "mention";
  readonly id?: string;
  readonly kind?: MessageMention["kind"];
  readonly label?: string;
  readonly filePath?: string;
  readonly path?: string;
  readonly name?: string;
  readonly provider?: string;
}

/** Mention metadata stored by the editor before range offsets are computed. */
export type MentionNodeData = MessageMention extends infer T
  ? T extends MessageMention
    ? Omit<T, "range">
    : never
  : never;

// ---------------------------------------------------------------------------
// MentionChip (React component rendered by decorate())
// ---------------------------------------------------------------------------

const CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-md border bg-sky-500/20 ring-1 ring-sky-500/30 px-1.5 py-0.5 text-xs align-baseline";

function MentionChip({ mention }: { readonly mention: MentionNodeData }): JSX.Element {
  const name = mention.kind === "file" ? basename(mention.path) : mention.label;
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

/** Inline decorator node rendering an @file mention chip. */
export class MentionNode extends DecoratorNode<JSX.Element> {
  __mention: MentionNodeData;

  static getType(): string {
    return "mention";
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__mention, node.__key);
  }

  constructor(mention: MentionNodeData, key?: NodeKey) {
    super(key);
    this.__mention = mention;
  }

  // -- Accessors ------------------------------------------------------------

  getFilePath(): string {
    return this.getLatest().__mention.path;
  }

  getMentionData(): MentionNodeData {
    return this.getLatest().__mention;
  }

  // -- Behavior -------------------------------------------------------------

  isInline(): boolean {
    return true;
  }

  getTextContent(): string {
    return `@${this.getMentionData().label}`;
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
      id: this.__mention.id,
      kind: this.__mention.kind,
      label: this.__mention.label,
      filePath: this.__mention.kind === "file" ? this.__mention.path : undefined,
      path: this.__mention.path,
      name: this.__mention.kind === "agent" ? this.__mention.name : undefined,
      provider: this.__mention.kind === "agent" ? this.__mention.provider : undefined,
      version: 1,
    };
  }

  static importJSON(serializedNode: SerializedMentionNode): MentionNode {
    const path = serializedNode.path ?? serializedNode.filePath ?? serializedNode.label ?? "";
    return $createTypedMentionNode({
      id: serializedNode.id ?? createMentionId(),
      kind: serializedNode.kind ?? "file",
      label: serializedNode.label ?? path,
      path,
      ...(serializedNode.kind === "agent" && serializedNode.name
        ? { name: serializedNode.name, provider: serializedNode.provider }
        : {}),
    } as MentionNodeData);
  }

  // -- Decoration -----------------------------------------------------------

  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return <MentionChip mention={this.__mention} />;
  }
}

// ---------------------------------------------------------------------------
// Helper exports
// ---------------------------------------------------------------------------

/** Create a new MentionNode for the given file path. */
export function $createMentionNode(filePath: string): MentionNode {
  return $createTypedMentionNode({
    id: createMentionId(),
    kind: "file",
    label: filePath,
    path: filePath,
  });
}

/** Create a new MentionNode for typed mention metadata. */
export function $createTypedMentionNode(mention: MentionNodeData): MentionNode {
  return new MentionNode(mention);
}

/** Type guard: returns true when the node is a MentionNode. */
export function $isMentionNode(
  node: LexicalNode | null | undefined,
): node is MentionNode {
  return node instanceof MentionNode;
}

function createMentionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `mention-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
