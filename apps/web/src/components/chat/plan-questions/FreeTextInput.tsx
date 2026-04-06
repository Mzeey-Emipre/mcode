interface FreeTextInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/** Optional freeform response field. */
export function FreeTextInput({ value, onChange, placeholder }: FreeTextInputProps) {
  return (
    <div className="mb-3 px-3 py-2 rounded-md border border-border/40 bg-muted/20 focus-within:border-border/70 transition-colors">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/30 mb-1 leading-none">
        Your response
      </p>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "Add your own response..."}
        className="w-full bg-transparent text-xs text-foreground/90 placeholder:text-muted-foreground/25 outline-none"
      />
    </div>
  );
}
