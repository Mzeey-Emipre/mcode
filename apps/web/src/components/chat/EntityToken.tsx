import type { ComponentProps } from "react";
import { Blocks, Sparkles, SquareTerminal, Zap } from "lucide-react";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { cn } from "@/lib/utils";
import { StackedLayersIcon } from "./narrative/StackedLayersIcon";

/** Entity categories that share one visual language across composer and transcript surfaces. */
export type EntityKind = "agent" | "command" | "file" | "mcode" | "plugin" | "skill";

/** Props for the compact identity icon used by entity tokens and suggestion rows. */
export interface EntityIconProps extends ComponentProps<"span"> {
  /** Entity category that determines the icon silhouette. */
  kind: EntityKind;
  /** File path used to resolve the exact file-type icon. */
  filePath?: string;
  /** Animate the sub-agent stack while its delegated work is running. */
  animated?: boolean;
  /** Pixel size of the glyph inside the icon frame. */
  size?: number;
}

/** Renders the canonical icon for a skill, plugin, command, file, or sub-agent. */
export function EntityIcon({
  kind,
  filePath,
  animated = false,
  size = 13,
  className,
  ...props
}: EntityIconProps) {
  const iconClassName = cn("shrink-0", className);

  if (kind === "file") {
    return (
      <span data-entity-icon={kind} className={iconClassName} {...props}>
        <FileTypeIcon filePath={filePath ?? "file"} size={size} />
      </span>
    );
  }

  if (kind === "agent") {
    return (
      <span data-entity-icon={kind} className={iconClassName} {...props}>
        <StackedLayersIcon
          animated={animated}
          style={{ width: size, height: size }}
        />
      </span>
    );
  }

  const Icon = kind === "skill"
    ? Sparkles
    : kind === "plugin"
      ? Blocks
      : kind === "mcode"
        ? Zap
        : SquareTerminal;

  return (
    <span data-entity-icon={kind} className={iconClassName} {...props}>
      <Icon aria-hidden="true" size={size} />
    </span>
  );
}

/** Props for an inline entity token shown inside drafted or persisted prose. */
export interface EntityTokenProps extends ComponentProps<"span"> {
  /** Entity category that determines the icon and accessible label. */
  kind: EntityKind;
  /** Text shown after the icon, including any meaningful trigger prefix. */
  label: string;
  /** File path used to resolve the exact file-type icon. */
  filePath?: string;
  /** Surface-specific contrast treatment. */
  tone?: "assistant" | "composer" | "user";
}

/** Renders a compact, baseline-aligned entity reference with a stable icon vocabulary. */
export function EntityToken({
  kind,
  label,
  filePath,
  tone = "assistant",
  className,
  ...props
}: EntityTokenProps) {
  return (
    <span
      data-entity-token={kind}
      className={cn(
        "mx-px inline-flex h-5 max-w-full items-center gap-1 rounded-md px-1.5 align-[-0.2em] font-sans text-xs font-medium leading-none ring-1 ring-inset",
        tone === "user"
          ? "bg-background/45 text-accent-foreground ring-foreground/10"
          : "bg-muted/70 text-foreground ring-border/70",
        tone === "composer" && "bg-muted/80",
        className,
      )}
      {...props}
    >
      <EntityIcon
        kind={kind}
        filePath={filePath}
        className={cn(
          "flex size-3.5 items-center justify-center text-muted-foreground",
          tone === "user" && "text-accent-foreground/60",
          kind === "mcode" && tone !== "user" && "text-primary/80",
        )}
      />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
