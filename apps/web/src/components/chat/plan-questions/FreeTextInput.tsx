import { Input } from "@/components/ui/input";

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
    <Input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? "Type your own answer, or leave blank to use the selected option"}
      className="mt-3"
    />
  );
}
