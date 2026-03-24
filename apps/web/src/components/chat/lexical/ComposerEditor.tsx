import { useCallback, useMemo, useRef, useEffect } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { type EditorState, type LexicalEditor } from "lexical";
import { MentionNode } from "./MentionNode";
import { SlashCommandNode } from "./SlashCommandNode";
import { MentionPlugin } from "./MentionPlugin";
import { SlashCommandPlugin } from "./SlashCommandPlugin";
import { KeyboardPlugin } from "./KeyboardPlugin";
import { getPlainTextFromEditor } from "./cursor-utils";

interface ComposerEditorProps {
  onChange: (text: string) => void;
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
  /** When true, intercept navigation keys for popup keyboard handling. */
  isPopupOpen?: boolean;
  /** Called when a navigation key is pressed while popup is open. Returns true if handled. */
  onPopupKeyDown?: (key: string) => boolean;
}

const EDITOR_THEME = {
  paragraph: "min-h-[1.5em]",
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
  isPopupOpen,
  onPopupKeyDown,
}: ComposerEditorProps) {
  const internalRef = useRef<LexicalEditor | null>(null);
  const ref = editorRef ?? internalRef;

  const initialConfig = useMemo(
    () => ({
      namespace: "McodeComposer",
      theme: EDITOR_THEME,
      nodes: [MentionNode, SlashCommandNode],
      onError: (error: Error) => {
        console.error("[ComposerEditor]", error);
      },
      editable: !disabled,
    }),
    [disabled],
  );

  const handleChange = useCallback(
    (_editorState: EditorState, editor: LexicalEditor) => {
      const text = getPlainTextFromEditor(editor);
      onChange(text);
    },
    [onChange],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="relative">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              aria-placeholder={placeholder}
              placeholder={
                <div className="pointer-events-none absolute left-4 top-3 text-sm text-muted-foreground">
                  {placeholder}
                </div>
              }
              style={{ minHeight: "1.5em", maxHeight: "200px", overflowY: "auto" }}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
        <EditorRefPlugin editorRef={ref} />
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
          isPopupOpen={isPopupOpen}
          onPopupKeyDown={onPopupKeyDown}
        />
      </div>
    </LexicalComposer>
  );
}
