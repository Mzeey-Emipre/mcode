import { useCallback, useRef, useEffect } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { type EditorState, type LexicalEditor } from "lexical";
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
  /** Called when @ trigger is detected - drives file autocomplete popup */
  onMentionTrigger: (text: string, cursorPos: number) => void;
  onMentionDismiss: () => void;
  isMentionPopupOpen: boolean;
  /** Called when / trigger is detected - drives slash command popup */
  onSlashTrigger: (value: string) => void;
  onSlashDismiss: () => void;
  isSlashPopupOpen: boolean;
  /** Ref callback to expose the LexicalEditor instance */
  editorRef?: React.MutableRefObject<LexicalEditor | null>;
  disabled?: boolean;
  placeholder?: string;
  /** DOM identifier for a focus target outside the editor. */
  id?: string;
  /** Accessible name for the editor control. */
  ariaLabel?: string;
  /** When false, Ctrl/Cmd+Enter submits and Enter inserts a line break. */
  submitOnEnter?: boolean;
  /** Uses the compact annotation sizing required by selected-text comments. */
  compact?: boolean;
  /** When true, intercept navigation keys for popup keyboard handling. */
  isPopupOpen?: boolean;
  /** Called when a navigation key is pressed while popup is open. Returns true if handled. */
  onPopupKeyDown?: (key: string) => boolean;
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
  onMentionTrigger,
  onMentionDismiss,
  isMentionPopupOpen,
  onSlashTrigger,
  onSlashDismiss,
  isSlashPopupOpen,
  editorRef,
  disabled,
  placeholder = "Ask for follow-up changes or attach images",
  id,
  ariaLabel,
  submitOnEnter,
  compact = false,
  isPopupOpen,
  onPopupKeyDown,
}: ComposerEditorProps) {
  const internalRef = useRef<LexicalEditor | null>(null);
  const ref = editorRef ?? internalRef;

  const initialConfig = useRef({
    namespace: "McodeComposer",
    theme: compact ? COMPACT_EDITOR_THEME : EDITOR_THEME,
    nodes: [MentionNode, SlashCommandNode],
    onError: (error: Error) => {
      console.error("[ComposerEditor]", error);
    },
    editable: true,
  }).current;

  const handleChange = useCallback(
    (_editorState: EditorState, editor: LexicalEditor) => {
      const message = extractComposerMessage(editor);
      onChange(message.text, message.mentions);
    },
    [onChange],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="relative">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className={compact
                ? "w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-5 text-foreground placeholder:text-muted-foreground focus:outline-none"
                : "w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"}
              id={id}
              aria-label={ariaLabel}
              aria-placeholder={placeholder}
              placeholder={
                <div className={compact
                  ? "pointer-events-none absolute left-2 top-1.5 text-sm text-muted-foreground"
                  : "pointer-events-none absolute left-4 top-3 text-sm text-muted-foreground"}>
                  {placeholder}
                </div>
              }
              style={{
                minHeight: compact ? COMPACT_EDITOR_MIN_HEIGHT : COMPOSER_MIN_HEIGHT,
                maxHeight: COMPOSER_MAX_HEIGHT,
                overflowY: "auto",
              }}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
        <EditorRefPlugin editorRef={ref} />
        <EditablePlugin disabled={disabled} />
        <MentionPlugin
          onTrigger={onMentionTrigger}
          onDismiss={onMentionDismiss}
          isPopupOpen={isMentionPopupOpen}
        />
        <SlashCommandPlugin
          onTrigger={onSlashTrigger}
          onDismiss={onSlashDismiss}
          isPopupOpen={isSlashPopupOpen}
        />
        <KeyboardPlugin
          onSubmit={onSubmit}
          disabled={disabled}
          submitOnEnter={submitOnEnter}
          isPopupOpen={isPopupOpen}
          onPopupKeyDown={onPopupKeyDown}
        />
      </div>
    </LexicalComposer>
  );
}
