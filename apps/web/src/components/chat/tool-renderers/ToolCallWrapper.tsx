import { useState, type ReactNode, Component, type ErrorInfo } from "react";
import { ChevronRight } from "lucide-react";
import type { IconComponent } from "./constants";

/** Extracted to avoid re-creating inline style objects each render. */
const SLOW_SPIN_STYLE = { animationDuration: "2s" } as const;

interface ToolCallWrapperProps {
  icon: IconComponent;
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
        <div className="pl-3 border-l-2 border-destructive/30 py-1 text-xs text-muted-foreground">
          Tool call render error
        </div>
      );
    }
    return this.props.children;
  }
}

function getWrapperClass(isActive: boolean): string {
  return `transition-colors rounded-sm ${isActive ? "bg-primary/5" : "hover:bg-muted/20"}`;
}

function getTriggerClass(hasContent: boolean): string {
  return `flex w-full flex-col gap-0.5 pl-3 pr-1 py-1.5 text-left text-sm ${hasContent ? "cursor-pointer hover:bg-muted/30" : "cursor-default"}`;
}

function getToolIconClass(isActive: boolean): string {
  return `shrink-0 ${isActive ? "animate-spin text-primary/80" : "text-muted-foreground/60"}`;
}

function getToolLabelClass(isActive: boolean): string {
  return `font-medium ${isActive ? "text-foreground font-medium" : "text-foreground/70"}`;
}

/** Cardless tool call row with left-accent gutter. */
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
    <div className={getWrapperClass(isActive)}>
      <button
        type="button"
        onClick={() => hasContent && setExpanded((p) => !p)}
        className={getTriggerClass(hasContent)}
      >
        <div className="flex w-full items-center gap-2">
          <Icon
            size={13}
            className={getToolIconClass(isActive)}
            style={isActive ? SLOW_SPIN_STYLE : undefined}
          />
          <span
            className={getToolLabelClass(isActive)}
          >
            {label}
          </span>

          {hasContent && (
            <ChevronRight
              size={11}
              className={`ml-auto shrink-0 text-muted-foreground/40 transition-transform ${
                expanded ? "rotate-90" : ""
              }`}
            />
          )}
        </div>

        {badge && (
          <span className="truncate pl-[21px] text-sm text-muted-foreground/50 font-mono">
            {badge}
          </span>
        )}
      </button>

      {expanded && children && (
        <div className="pl-3 pr-1 pb-1.5">
          {children}
        </div>
      )}
    </div>
  );
}

/** Cardless tool call row wrapped in an error boundary to prevent chat crashes. */
export function ToolCallWrapper(props: ToolCallWrapperProps) {
  return (
    <ToolCallErrorBoundary>
      <ToolCallWrapperInner {...props} />
    </ToolCallErrorBoundary>
  );
}
