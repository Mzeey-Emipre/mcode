import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  $createTextNode,
  TextNode,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import {
  $createSlashCommandNode,
  type SlashCommandNamespace,
} from "./SlashCommandNode";
import {
  $createTypedMentionNode,
  createMentionId,
  type MentionNodeData,
} from "./MentionNode";
import { SLASH_TRIGGER_RE, type Command } from "../useSlashCommand";

/** Props for the SlashCommandPlugin that detects /-triggers in the editor. */
interface SlashCommandPluginProps {
  /** Called when a /command trigger is detected, with the full text content. */
  readonly onTrigger: (value: string) => void;
  /** Called to close the slash popup when the trigger is no longer valid. */
  readonly onDismiss: () => void;
  /** Whether the slash command popup is currently visible. */
  readonly isPopupOpen: boolean;
}

/**
 * Lexical plugin that detects /-triggers for slash commands.
 *
 * Uses refs for callbacks to register the update listener once,
 * avoiding re-registration on every prop change.
 */
export function SlashCommandPlugin({
  onTrigger,
  onDismiss,
  isPopupOpen,
}: SlashCommandPluginProps): null {
  const [editor] = useLexicalComposerContext();

  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const isPopupOpenRef = useRef(isPopupOpen);
  isPopupOpenRef.current = isPopupOpen;

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          if (isPopupOpenRef.current) onDismissRef.current();
          return;
        }

        const anchor = selection.anchor;
        if (anchor.type !== "text") {
          if (isPopupOpenRef.current) onDismissRef.current();
          return;
        }

        const node = anchor.getNode();
        if (!(node instanceof TextNode)) {
          if (isPopupOpenRef.current) onDismissRef.current();
          return;
        }

        const textContent = node.getTextContent();
        const cursorOffset = anchor.offset;
        const textBeforeCursor = textContent.slice(0, cursorOffset);

        const match = SLASH_TRIGGER_RE.exec(textBeforeCursor);
        if (!match) {
          if (isPopupOpenRef.current) onDismissRef.current();
          return;
        }

        // Pass only text before the cursor so the regex $ anchor matches
        onTriggerRef.current(textBeforeCursor);
      });
    });
  }, [editor]);

  return null;
}

function replaceActiveSlashTrigger(
  editor: LexicalEditor,
  createNode: () => LexicalNode,
): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;

    const anchor = selection.anchor;
    if (anchor.type !== "text") return;

    const node = anchor.getNode();
    if (!(node instanceof TextNode)) return;

    const textContent = node.getTextContent();
    const cursorOffset = anchor.offset;
    const match = SLASH_TRIGGER_RE.exec(textContent.slice(0, cursorOffset));
    if (!match) return;

    const triggerStart = match.index + match[1].length;
    const beforeText = textContent.slice(0, triggerStart);
    const afterCursor = textContent.slice(cursorOffset);
    const insertedNode = createNode();
    const trailingText = afterCursor.length > 0 ? afterCursor : " ";
    const afterNode = $createTextNode(trailingText);

    if (beforeText) {
      const beforeNode = $createTextNode(beforeText);
      node.replace(beforeNode);
      beforeNode.insertAfter(insertedNode);
      insertedNode.insertAfter(afterNode);
    } else {
      node.replace(insertedNode);
      insertedNode.insertAfter(afterNode);
    }

    const offset = trailingText.startsWith(" ") ? 1 : 0;
    afterNode.select(offset, offset);
  });
}

/** Replaces the active slash trigger with a native Codex plugin mention. */
export function insertPluginMentionNode(
  editor: LexicalEditor,
  mention: Extract<MentionNodeData, { kind: "plugin" }>,
): void {
  replaceActiveSlashTrigger(editor, () => $createTypedMentionNode(mention));
}

/**
 * Insert a slash command node at the current / trigger position.
 */
export function insertSlashCommandNode(
  editor: LexicalEditor,
  commandName: string,
  namespace: SlashCommandNamespace,
): void {
  replaceActiveSlashTrigger(editor, () => $createSlashCommandNode(commandName, namespace));
}

/** Inserts a selected plugin command as a native Codex mention. */
export function insertSelectedPluginMention(
  editor: LexicalEditor,
  command: Pick<Command, "capabilityKind" | "mentionPath" | "name">,
): boolean {
  if (command.capabilityKind !== "plugin" || !command.mentionPath) return false;
  insertPluginMentionNode(editor, {
    id: createMentionId(),
    kind: "plugin",
    label: command.name,
    name: command.name,
    path: command.mentionPath,
  });
  return true;
}

/** Removes the slash trigger at the current selection without inserting a command node. */
export function removeSlashCommandTrigger(editor: LexicalEditor): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;

    const anchor = selection.anchor;
    if (anchor.type !== "text") return;

    const node = anchor.getNode();
    if (!(node instanceof TextNode)) return;

    const textContent = node.getTextContent();
    const cursorOffset = anchor.offset;
    const match = SLASH_TRIGGER_RE.exec(textContent.slice(0, cursorOffset));
    if (!match) return;

    const triggerStart = match.index + match[1].length;
    const nextText = textContent.slice(0, triggerStart) + textContent.slice(cursorOffset);
    node.setTextContent(nextText);
    node.select(triggerStart, triggerStart);
  });
}
