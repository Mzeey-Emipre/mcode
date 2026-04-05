interface FreeTextInputProps {
  /** Current free-text value. */
  value: string;
  /** Called when the value changes. */
  onChange: (value: string) => void;
  /** Input placeholder. */
  placeholder?: string;
}

/** Optional free-text override grounded in a muted container with a visible focus state. */
export function FreeTextInput({ value, onChange, placeholder }: FreeTextInputProps) {
  return (
    <div className="mb-3 rounded-md border border-border/50 bg-muted/20 focus-within:border-border focus-within:bg-muted/30 transition-colors px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/35 mb-1.5 leading-none">
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
