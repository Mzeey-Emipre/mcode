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
 * Styled with subtle warm gray background, left border accent on focus.
 */
export function FreeTextInput({ value, onChange, placeholder }: FreeTextInputProps) {
  return (
    <div className="mb-6 pb-6 border-b border-[#e5e1d8]">
      <label className="block text-xs font-medium text-[#666] uppercase tracking-[0.08em] mb-2">
        Your response (optional)
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "Add your own response..."}
        className="w-full px-3 py-2 text-sm bg-[#f3f2f0] border-l-4 border-r border-b border-t-0 border-[#e5e1d8] border-l-transparent text-[#0f0f0f] placeholder:text-[#999] transition-all duration-200 focus-visible:outline-none focus-visible:border-l-[#0891b2] focus-visible:ring-1 focus-visible:ring-[#0891b2]/30"
      />
    </div>
  );
}
