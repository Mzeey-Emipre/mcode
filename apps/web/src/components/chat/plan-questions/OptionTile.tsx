import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useRef, type RefObject } from "react";
import type { PlanQuestionOption } from "@mcode/contracts";

interface OptionTileProps {
  /** The option data. */
  option: PlanQuestionOption;
  /** Whether this tile is currently selected. */
  selected: boolean;
  /** Whether this option is the model's recommended choice. */
  isRecommended?: boolean;
  /** Called when the user clicks or keyboard-selects this tile. */
  onSelect: (optionId: string) => void;
  /** When true, shows a textarea instead of description when selected. */
  isOtherTile?: boolean;
  /** Current free-text value for the "Other" tile. */
  otherText?: string;
  /** Called when the user types in the "Other" textarea. */
  onOtherTextChange?: (text: string) => void;
  /** Index used to stagger the entrance and accept-all flash animations. */
  index?: number;
  /** When true, play the accept-all flash exactly once. */
  flashing?: boolean;
}

function OptionTileHeading({
  option,
  selected,
  recommended,
  flashing,
  index,
}: {
  option: PlanQuestionOption;
  selected: boolean;
  recommended: boolean | undefined;
  flashing: boolean;
  index: number;
}) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap">
      <span
        className={cn(
          "text-sm leading-snug",
          flashing && "animate-wizard-accept-flash",
          selected ? "font-medium text-foreground" : "text-foreground/80",
        )}
        style={flashing ? { ["--tile-index" as string]: index } : undefined}
      >
        {option.title}
      </span>
      {recommended && <span className="text-xs font-mono uppercase tracking-wider text-primary/65 leading-none">· recommended</span>}
    </div>
  );
}

function OptionTileDetails({
  option,
  selected,
  isOtherTile,
  otherText,
  onOtherTextChange,
  textareaRef,
}: {
  option: PlanQuestionOption;
  selected: boolean;
  isOtherTile: boolean | undefined;
  otherText: string;
  onOtherTextChange: ((text: string) => void) | undefined;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  if (isOtherTile && selected) {
    return (
      <Textarea
        ref={textareaRef}
        value={otherText}
        onChange={(event) => onOtherTextChange?.(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        placeholder="Describe your preference..."
        rows={2}
        className={cn(
          "mt-2 min-h-0 rounded-none border-0 border-b border-border/40 bg-transparent px-0 py-1.5 text-xs",
          "shadow-none focus-visible:ring-0 focus-visible:border-primary/50",
          "resize-none",
        )}
      />
    );
  }
  if (isOtherTile || !option.description) return null;
  return (
    <p className={cn("text-xs mt-1 leading-relaxed", selected ? "text-muted-foreground/80" : "text-muted-foreground/45")}>
      {option.description}
    </p>
  );
}

/**
 * Selectable option tile rendered as an editorial list row rather than a
 * form radio. The selection state is signaled by a leading `▸` chevron,
 * a subtle background tint, and a weight shift on the title — keeping the
 * tile visually quiet until the user engages it. Tiles enter with a
 * staggered translate+fade choreography orchestrated by the parent.
 */
export function OptionTile({
  option,
  selected,
  isRecommended,
  onSelect,
  isOtherTile,
  otherText = "",
  onOtherTextChange,
  index = 0,
  flashing = false,
}: OptionTileProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus textarea when "Other" is selected
  useEffect(() => {
    if (isOtherTile && selected) {
      textareaRef.current?.focus();
    }
  }, [isOtherTile, selected]);

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(option.id)}
      style={{ ["--tile-index" as string]: index }}
      className={cn(
        "group relative w-full text-left animate-wizard-tile",
        "px-3 py-2.5 cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40",
        "transition-colors duration-150 ease-out",
        selected ? "bg-primary/[0.06]" : "hover:bg-foreground/[0.025]",
      )}
    >
      <div className="flex items-baseline gap-2">
        {/* Leading chevron: invisible until selected, then slides in from
            the left margin. Sized to match the `▸ assistant` prose marker
            so the wizard reads as part of the assistant's voice. */}
        <span
          aria-hidden="true"
          className={cn(
            "font-mono text-xs leading-none w-2.5 flex-shrink-0",
            "transition-[opacity,transform] duration-200 ease-out",
            selected
              ? "opacity-100 translate-x-0 text-primary"
              : "opacity-0 -translate-x-1 text-muted-foreground/30",
          )}
        >
          ▸
        </span>

        <div className="flex-1 min-w-0">
          <OptionTileHeading
            option={option}
            selected={selected}
            recommended={isRecommended}
            flashing={flashing}
            index={index}
          />
          <OptionTileDetails
            option={option}
            selected={selected}
            isOtherTile={isOtherTile}
            otherText={otherText}
            onOtherTextChange={onOtherTextChange}
            textareaRef={textareaRef}
          />
        </div>
      </div>
    </button>
  );
}
