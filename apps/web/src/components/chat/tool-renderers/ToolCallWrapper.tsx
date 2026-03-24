import { useState, type ReactNode, Component, type ErrorInfo } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";

interface ToolCallWrapperProps {
  icon: LucideIcon;
  label: string;
  badge?: string;
  isActive?: boolean;
  children?: ReactNode;
  defaultExpanded?: boolean;
}

/** Catches render errors in tool renderers so they don't crash the whole chat. */
class ToolCallErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ToolCallRenderer]", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-lg border border-border/40 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
          Tool call render error
        </div>
      );
    }
    return this.props.children;
  }
}

function ToolCallWrapperInner({
  icon: Icon,
  label,
  badge,
  isActive = false,
  children,
  defaultExpanded = false,
}: ToolCallWrapperProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasContent = !!children;

  return (
    <div
      className={`rounded-lg border overflow-hidden ${
        isActive
          ? "animate-tool-pulse border-border/60 bg-muted/20"
          : "border-border/40 bg-muted/15"
      }`}
    >
      <button
        type="button"
        onClick={() => hasContent && setExpanded((p) => !p)}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${hasContent ? "cursor-pointer hover:bg-muted/30" : "cursor-default"}`}
      >
        <Icon size={14} className="shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground/80">{label}</span>

        <div className="flex flex-1 items-center justify-end gap-2 min-w-0">
          {badge && (
            <span className="max-w-[200px] truncate rounded-full bg-secondary px-2 py-0.5 text-[10px] font-normal text-secondary-foreground">
              {badge}
            </span>
          )}

          {hasContent && (
            <ChevronRight
              size={12}
              className={`shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          )}
        </div>
      </button>

      {expanded && children && (
        <div className="border-t border-border/30 px-3 py-2">
          {children}
        </div>
      )}
    </div>
  );
}

export function ToolCallWrapper(props: ToolCallWrapperProps) {
  return (
    <ToolCallErrorBoundary>
      <ToolCallWrapperInner {...props} />
    </ToolCallErrorBoundary>
  );
}
