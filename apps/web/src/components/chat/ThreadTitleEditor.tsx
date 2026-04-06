import { useRef, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";

interface ThreadTitleEditorProps {
  /** The current title of the thread. */
  title: string;
  /** Whether the editor is in edit mode. */
  isEditing: boolean;
  /** Called when the title is saved with the new value. */
  onSave: (newTitle: string) => void;
  /** Called when editing is cancelled (e.g., via Escape key). */
  onCancel: () => void;
}

/**
 * Renders a thread title as either a static span or an editable input.
 * When isEditing is true, shows an input with text selection and handles Enter/Escape/blur events.
 * Prevents saving empty or whitespace-only titles.
 */
export function ThreadTitleEditor({
  title,
  isEditing,
  onSave,
  onCancel,
}: ThreadTitleEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const didSaveRef = useRef(false);
  const [originalTitle, setOriginalTitle] = useState(title);

  useEffect(() => {
    if (isEditing) {
      didSaveRef.current = false;
      setOriginalTitle(title);
      // Focus and select all text when entering edit mode
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }
  }, [isEditing]);

  const handleSave = (newTitle: string) => {
    const trimmed = newTitle.trim();
    if (trimmed && trimmed !== originalTitle) {
      onSave(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave(inputRef.current?.value || "");
      // Set after handleSave so blur (which fires after Enter) is gated, not the save itself
      didSaveRef.current = true;
    } else if (e.key === "Escape") {
      e.preventDefault();
      didSaveRef.current = true;
      onCancel();
    }
  };

  const handleBlur = () => {
    if (!didSaveRef.current && inputRef.current) {
      handleSave(inputRef.current.value);
    }
  };

  if (!isEditing) {
    return <span className="text-sm font-medium text-foreground">{title}</span>;
  }

  return (
    <Input
      ref={inputRef}
      type="text"
      defaultValue={title}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      size="sm"
    />
  );
}
