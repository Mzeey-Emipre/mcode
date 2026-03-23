import { useState, useEffect, useRef } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type NamingMode = "auto" | "custom";

interface NamingModeSelectorProps {
  mode: NamingMode;
  onModeChange: (mode: NamingMode) => void;
}

const NAMING_OPTIONS: Array<{ value: NamingMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "custom", label: "Custom" },
];

export function NamingModeSelector({ mode, onModeChange }: NamingModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selected = NAMING_OPTIONS.find((o) => o.value === mode) ?? NAMING_OPTIONS[0];

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {selected.label}
        <ChevronDown size={9} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[100px] rounded-md border border-border bg-popover p-1 shadow-lg">
          {NAMING_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                onModeChange(option.value);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs",
                option.value === mode
                  ? "bg-accent text-foreground"
                  : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <span className="flex-1 text-left">{option.label}</span>
              {option.value === mode && <Check size={10} className="text-muted-foreground" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
