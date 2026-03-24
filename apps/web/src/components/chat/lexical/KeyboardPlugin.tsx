import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from "lexical";

interface KeyboardPluginProps {
  readonly onSubmit: () => void;
  readonly disabled?: boolean;
}

/**
 * Lexical plugin for keyboard shortcuts.
 * - Enter (without Shift): submit message
 * - Shift+Enter: insert newline (default Lexical behavior)
 */
export function KeyboardPlugin({
  onSubmit,
  disabled,
}: KeyboardPluginProps): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event) return false;
        if (event.shiftKey) return false;
        event.preventDefault();
        if (!disabled) {
          onSubmit();
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onSubmit, disabled]);

  return null;
}
