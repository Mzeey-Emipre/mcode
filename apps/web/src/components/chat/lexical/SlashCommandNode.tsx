/**
 * Lexical DecoratorNode for /command slash-command chips.
 *
 * Renders an inline chip with a namespace-colored icon and the command name.
 * Serializes as `/<commandName>` for plain-text extraction.
 */
import type { JSX } from "react";
import {
  DecoratorNode,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
} from "lexical";
import { Terminal, Zap, Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The origin namespace of a slash command: built-in, skill, or plugin. */
export type SlashCommandNamespace = "skill" | "mcode" | "plugin" | "command";

/** JSON-serialized form of a SlashCommandNode for editor state persistence. */
export interface SerializedSlashCommandNode extends SerializedLexicalNode {
  readonly type: "slash-command";
  readonly commandName: string;
  readonly namespace: SlashCommandNamespace;
}

// ---------------------------------------------------------------------------
// Namespace styling
// ---------------------------------------------------------------------------

const NAMESPACE_STYLES: Record<SlashCommandNamespace, string> = {
  skill: "bg-emerald-500/25 ring-1 ring-emerald-500/40",
  mcode: "bg-primary/25 ring-1 ring-primary/40",
  plugin: "bg-orange-500/25 ring-1 ring-orange-500/40",
  command: "bg-sky-500/25 ring-1 ring-sky-500/40",
};

/** Valid namespace values for deserialisation fallback. */
const VALID_NAMESPACES = new Set<SlashCommandNamespace>(["skill", "mcode", "plugin", "command"]);

const NAMESPACE_ICONS: Record<SlashCommandNamespace, typeof Terminal> = {
  skill: Terminal,
  mcode: Zap,
  plugin: Puzzle,
  command: Terminal,
};

// ---------------------------------------------------------------------------
// SlashCommandChip (React component rendered by decorate())
// ---------------------------------------------------------------------------

const CHIP_BASE =
  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs align-baseline";

function SlashCommandChip({
  commandName,
  namespace,
}: {
  readonly commandName: string;
  readonly namespace: SlashCommandNamespace;
}): JSX.Element {
  const Icon = NAMESPACE_ICONS[namespace];
  return (
    <span className={cn(CHIP_BASE, NAMESPACE_STYLES[namespace])}>
      <Icon className="size-3.5" />
      /{commandName}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SlashCommandNode (Lexical DecoratorNode)
// ---------------------------------------------------------------------------

export class SlashCommandNode extends DecoratorNode<JSX.Element> {
  __commandName: string;
  __namespace: SlashCommandNamespace;

  static getType(): string {
    return "slash-command";
  }

  static clone(node: SlashCommandNode): SlashCommandNode {
    return new SlashCommandNode(
      node.__commandName,
      node.__namespace,
      node.__key,
    );
  }

  constructor(
    commandName: string,
    namespace: SlashCommandNamespace,
    key?: NodeKey,
  ) {
    super(key);
    this.__commandName = commandName;
    this.__namespace = namespace;
  }

  // -- Accessors ------------------------------------------------------------

  getCommandName(): string {
    return this.getLatest().__commandName;
  }

  getNamespace(): SlashCommandNamespace {
    return this.getLatest().__namespace;
  }

  // -- Behavior -------------------------------------------------------------

  isInline(): boolean {
    return true;
  }

  getTextContent(): string {
    return `/${this.getCommandName()}`;
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

  exportJSON(): SerializedSlashCommandNode {
    return {
      type: "slash-command",
      commandName: this.__commandName,
      namespace: this.__namespace,
      version: 1,
    };
  }

  static importJSON(
    serializedNode: SerializedSlashCommandNode,
  ): SlashCommandNode {
    const ns = VALID_NAMESPACES.has(serializedNode.namespace)
      ? serializedNode.namespace
      : "mcode";
    return $createSlashCommandNode(serializedNode.commandName, ns);
  }

  // -- Decoration -----------------------------------------------------------

  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return (
      <SlashCommandChip
        commandName={this.__commandName}
        namespace={this.__namespace}
      />
    );
  }
}

// ---------------------------------------------------------------------------
// Helper exports
// ---------------------------------------------------------------------------

/** Create a new SlashCommandNode with the given name and namespace. */
export function $createSlashCommandNode(
  commandName: string,
  namespace: SlashCommandNamespace,
): SlashCommandNode {
  return new SlashCommandNode(commandName, namespace);
}

/** Type guard: returns true when the node is a SlashCommandNode. */
export function $isSlashCommandNode(
  node: LexicalNode | null | undefined,
): node is SlashCommandNode {
  return node instanceof SlashCommandNode;
}
