interface FreeTextInputProps {
  /** Current free-text value. */
  value: string;
  /** Called when the value changes. */
  onChange: (value: string) => void;
  /** Input placeholder. */
  placeholder?: string;
}

/** Optional free-text override. Grounded in a muted container with a focus indicator. */
export function FreeTextInput({ value, onChange, placeholder }: FreeTextInputProps) {
  return (
    <div className="mb-3 rounded-md bg-muted/30 border border-border/50 focus-within:border-border transition-colors px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40 mb-1.5">
        Your response
      </p>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "Add your own response..."}
        className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground/30 outline-none"
      />
    </div>
  );
}
