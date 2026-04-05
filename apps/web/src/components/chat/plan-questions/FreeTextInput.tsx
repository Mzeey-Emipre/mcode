interface FreeTextInputProps {
  /** Current free-text value. */
  value: string;
  /** Called when the value changes. */
  onChange: (value: string) => void;
  /** Input placeholder. */
  placeholder?: string;
}

/**
 * Optional free-text override for a plan question.
 * When non-empty, takes precedence over the selected option on submission.
 */
export function FreeTextInput({ value, onChange, placeholder }: FreeTextInputProps) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? "Type your own answer, or leave blank to use the selected option"}
      className={
        "mt-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm " +
        "text-foreground placeholder:text-muted-foreground " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      }
    />
  );
}
