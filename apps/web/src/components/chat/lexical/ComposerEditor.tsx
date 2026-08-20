import { useCallback, useRef, useEffect } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $createTextNode, $getRoot, HISTORY_MERGE_TAG, type EditorState, type LexicalEditor } from "lexical";
import type { MessageMention } from "@mcode/contracts";
import { MentionNode } from "./MentionNode";
import { SlashCommandNode } from "./SlashCommandNode";
import { MentionPlugin } from "./MentionPlugin";
import { SlashCommandPlugin } from "./SlashCommandPlugin";
import { KeyboardPlugin } from "./KeyboardPlugin";
import { extractComposerMessage } from "./cursor-utils";

interface ComposerEditorProps {
  onChange: (text: string, mentions: MessageMention[]) => void;
  onSubmit: () => void;
  /** Keyboard shortcut that submits the editor. Defaults to Enter. */
  submitShortcut?: "enter" | "mod-enter";
  /** Called when Escape is pressed while no popup is open. */
  onEscape?: () => void;
  /** Called when @ trigger is detected - drives file autocomplete popup */
  onMentionTrigger?: (text: string, cursorPos: number) => void;
  onMentionDismiss?: () => void;
  isMentionPopupOpen?: boolean;
  /** Called when / trigger is detected - drives slash command popup */
  onSlashTrigger?: (value: string) => void;
  onSlashDismiss?: () => void;
  isSlashPopupOpen?: boolean;
  /** Ref callback to expose the LexicalEditor instance */
  editorRef?: React.MutableRefObject<LexicalEditor | null>;
  disabled?: boolean;
  placeholder?: string;
  /** When true, intercept navigation keys for popup keyboard handling. */
  isPopupOpen?: boolean;
  /** Called when a navigation key is pressed while popup is open. Returns true if handled. */
  onPopupKeyDown?: (key: string) => boolean;
  /** Seeds a new editor instance with plain text content. */
  initialText?: string;
  /** Uses a compact auto-growing annotation surface instead of composer sizing. */
  compact?: boolean;
  /** Limits plain-text content and emitted text to this many characters. */
  maxLength?: number;
  /** Focuses the contenteditable when this editor instance mounts. */
  autoFocus?: boolean;
  /** Accessible label for the contenteditable surface. */
  ariaLabel?: string;
  /** Optional keyboard hint shown by the contenteditable surface. */
  title?: string;
}

const COMPOSER_MIN_HEIGHT = "80px";
const COMPOSER_MAX_HEIGHT = "30vh";
const COMPACT_EDITOR_MIN_HEIGHT = "2.25rem";

const EDITOR_THEME = {
  paragraph: `min-h-[${COMPOSER_MIN_HEIGHT}]`,
};

const COMPACT_EDITOR_THEME = {
  paragraph: "min-h-0",
};

function initializePlainText(text: string): void {
  const root = $getRoot();
  root.clear();
  for (const line of text.split("\n")) {
    const paragraph = $createParagraphNode();
    if (line) paragraph.append($createTextNode(line));
    root.append(paragraph);
  }
}

/** Internal plugin that exposes the editor instance via ref. */
function EditorRefPlugin({
  editorRef,
}: {
  editorRef: React.MutableRefObject<LexicalEditor | null>;
}): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
  }, [editor, editorRef]);
  return null;
}

/** Internal plugin that syncs the editor's editable state with the disabled prop. */
function EditablePlugin({ disabled }: { readonly disabled?: boolean }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.setEditable(!disabled);
  }, [editor, disabled]);
  return null;
}

/** Rich text composer with inline mention/slash-command chip support. */
export function ComposerEditor({
  onChange,
  onSubmit,
  submitShortcut = "enter",
  onEscape,
  onMentionTrigger,
  onMentionDismiss,
  isMentionPopupOpen,
  onSlashTrigger,
  onSlashDismiss,
  isSlashPopupOpen,
  editorRef,
  disabled,
  placeholder = "Ask for follow-up changes or attach images",
  isPopupOpen,
  onPopupKeyDown,
  initialText,
  compact = false,
  maxLength,
  autoFocus = false,
  ariaLabel,
  title,
}: ComposerEditorProps) {
  const internalRef = useRef<LexicalEditor | null>(null);
  const ref = editorRef ?? internalRef;
  const characterLimit = maxLength !== undefined && Number.isFinite(maxLength) && maxLength >= 0
    ? Math.floor(maxLength)
    : undefined;
  const seededText = initialText === undefined || characterLimit === undefined
    ? initialText
    : initialText.slice(0, characterLimit);

  const initialConfig = useRef({
    namespace: "McodeComposer",
    theme: compact ? COMPACT_EDITOR_THEME : EDITOR_THEME,
    nodes: [MentionNode, SlashCommandNode],
    onError: (error: Error) => {
      console.error("[ComposerEditor]", error);
    },
    editable: true,
    editorState: seededText === undefined ? undefined : () => initializePlainText(seededText),
  }).current;

  const handleChange = useCallback(
    (_editorState: EditorState, editor: LexicalEditor) => {
      const message = extractComposerMessage(editor);
      if (characterLimit !== undefined && message.text.length > characterLimit) {
        if (editor.isComposing()) return;
        const truncatedText = message.text.slice(0, characterLimit);
        editor.update(() => {
          initializePlainText(truncatedText);
          $getRoot().selectEnd();
        }, { tag: HISTORY_MERGE_TAG });
        return;
      }
      onChange(message.text, message.mentions);
    },
    [characterLimit, onChange],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="relative">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className={compact
                ? "w-full resize-none scrollbar-on-hover bg-transparent px-2 py-1.5 text-sm leading-5 text-foreground placeholder:text-muted-foreground focus:outline-none"
                : "w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"}
              aria-placeholder={placeholder}
              aria-label={ariaLabel}
              title={title}
              placeholder={
                <div className={compact
                  ? "pointer-events-none absolute left-2 top-1.5 text-sm text-muted-foreground"
                  : "pointer-events-none absolute left-4 top-3 text-sm text-muted-foreground"}>
                  {placeholder}
                </div>
              }
              style={{
                minHeight: COMPOSER_MIN_HEIGHT,
                maxHeight: COMPOSER_MAX_HEIGHT,
                overflowY: "auto",
                ...(compact
                  ? {
                      minHeight: COMPACT_EDITOR_MIN_HEIGHT,
                    }
                  : {}),
              }}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
        {autoFocus && <AutoFocusPlugin />}
        <EditorRefPlugin editorRef={ref} />
        <EditablePlugin disabled={disabled} />
        {onMentionTrigger && onMentionDismiss && isMentionPopupOpen !== undefined && (
          <MentionPlugin
            onTrigger={onMentionTrigger}
            onDismiss={onMentionDismiss}
            isPopupOpen={isMentionPopupOpen}
          />
        )}
        {onSlashTrigger && onSlashDismiss && isSlashPopupOpen !== undefined && (
          <SlashCommandPlugin
            onTrigger={onSlashTrigger}
            onDismiss={onSlashDismiss}
            isPopupOpen={isSlashPopupOpen}
          />
        )}
        <KeyboardPlugin
          onSubmit={onSubmit}
          submitShortcut={submitShortcut}
          onEscape={onEscape}
          disabled={disabled}
          isPopupOpen={isPopupOpen}
          onPopupKeyDown={onPopupKeyDown}
        />
      </div>
    </LexicalComposer>
  );
}
