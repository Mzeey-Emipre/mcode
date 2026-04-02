import { useState } from "react";

interface RangeControlProps {
  /** Minimum slider value. */
  min: number;
  /** Maximum slider value. */
  max: number;
  /** Step increment. */
  step?: number;
  /** Current persisted value from the store. */
  value: number;
  /** Called with the final value when the user finishes dragging. */
  onCommit: (value: number) => void;
  /** Optional formatter for the displayed value (e.g. append " MB"). */
  formatValue?: (value: number) => string;
}

/**
 * Themed range slider that defers store writes until the drag ends.
 * Local state tracks the in-progress value to avoid RPC on every pixel.
 */
export function RangeControl({
  min,
  max,
  step = 1,
  value,
  onCommit,
  formatValue,
}: RangeControlProps) {
  const [local, setLocal] = useState<number | null>(null);
  const display = local ?? value;
  const formatted = formatValue ? formatValue(display) : String(display);

  const commit = (v: number) => {
    setLocal(null);
    onCommit(v);
  };

  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={display}
        onChange={(e) => setLocal(Number(e.target.value))}
        onMouseUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onTouchEnd={(e) => commit(Number((e.target as HTMLInputElement).value))}
        className="settings-range flex-1"
      />
      <span className="min-w-[2.5rem] text-right font-mono text-xs text-foreground">
        {formatted}
      </span>
    </div>
  );
}
