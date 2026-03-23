import { useRef, useEffect } from "react";
import { GitBranch } from "lucide-react";
import type { NamingMode } from "@/lib/settings";
import { Input } from "@/components/ui/input";

interface BranchNameInputProps {
  namingMode: NamingMode;
  autoPreview: string;
  customValue: string;
  onCustomChange: (value: string) => void;
}

/**
 * Shows the branch name for a new worktree.
 * In auto mode, renders a greyed-out preview (e.g. `mcode-a1b2c3`).
 * In custom mode, renders an editable text input.
 */
export function BranchNameInput({
  namingMode,
  autoPreview,
  customValue,
  onCustomChange,
}: BranchNameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (namingMode === "custom") {
      inputRef.current?.focus();
    }
  }, [namingMode]);

  if (namingMode === "auto") {
    return (
      <span className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground/50">
        <GitBranch size={11} />
        {autoPreview}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <GitBranch size={11} className="text-muted-foreground" />
      <Input
        ref={inputRef}
        type="text"
        value={customValue}
        onChange={(e) => onCustomChange(e.target.value)}
        placeholder="branch-name"
        className="h-auto w-[160px] rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground placeholder:text-muted-foreground/50 focus-visible:border-primary"
      />
    </div>
  );
}
