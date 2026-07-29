import type { ComponentProps } from "react";
import {
  BadgeCheck,
  Gauge,
  ListTodo,
  Minimize2,
  Plug,
  SquareTerminal,
  Target,
  Zap,
} from "lucide-react";
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
  /** Slash-command name used to resolve a command's semantic icon. */
  commandName?: string;
  /** Pixel size of the glyph inside the icon frame. */
  size?: number;
}

/** Renders the canonical icon for a skill, plugin, command, file, or sub-agent. */
export function EntityIcon({
  kind,
  filePath,
  animated = false,
  commandName,
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

  const namedCommandIcon =
    commandName === "goal"
      ? Target
      : commandName === "plan"
        ? ListTodo
        : commandName === "ultra"
          ? Gauge
          : commandName === "compact"
            ? Minimize2
            : null;
  const Icon = kind === "skill"
    ? BadgeCheck
    : kind === "plugin"
      ? Plug
      : namedCommandIcon ?? (kind === "mcode" ? Zap : SquareTerminal);

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
  /** Renders the entity as a slash-command invocation while retaining its source namespace. */
  invocation?: boolean;
}

/** Renders a compact, baseline-aligned entity reference with a stable icon vocabulary. */
export function EntityToken({
  kind,
  label,
  filePath,
  tone = "assistant",
  invocation = false,
  className,
  ...props
}: EntityTokenProps) {
  const isCommandInvocation = kind === "command" || invocation;
  const isCapabilityReference = isCommandInvocation || kind === "plugin";
  const displayLabel = isCommandInvocation
    ? label.replace(/^\/+/, "")
    : kind === "plugin"
      ? label.replace(/^@+/, "")
      : label;

  return (
    <span
      data-entity-token={kind}
      className={cn(
        "mx-px inline-flex max-w-full items-center gap-1 align-[-0.2em] font-sans text-[length:inherit] font-medium leading-none",
        isCapabilityReference
          ? "text-primary"
          : tone === "user"
            ? "h-5 rounded-md bg-background/45 px-1.5 text-accent-foreground ring-1 ring-inset ring-foreground/10"
            : "h-5 rounded-md bg-muted/70 px-1.5 text-foreground ring-1 ring-inset ring-border/70",
        tone === "composer" && !isCapabilityReference && "bg-muted/80",
        className,
      )}
      {...props}
    >
      <EntityIcon
        kind={kind}
        filePath={filePath}
        commandName={isCommandInvocation ? displayLabel : undefined}
        className={cn(
          "flex size-3.5 items-center justify-center text-muted-foreground",
          isCapabilityReference && "text-current",
          tone === "user" && !isCapabilityReference && "text-accent-foreground/60",
          kind === "mcode" && tone !== "user" && "text-primary/80",
        )}
      />
      <span className="min-w-0 truncate">{displayLabel}</span>
    </span>
  );
}
