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
 */
export function FreeTextInput({ value, onChange, placeholder }: FreeTextInputProps) {
  return (
    <div className="mb-4 pl-3 border-l-2 border-l-transparent">
      <label className="block text-[11px] text-muted-foreground/50 mb-1.5">
        Your response (optional)
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "Add your own response..."}
        className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 border-none outline-none focus:outline-none"
      />
    </div>
  );
}
