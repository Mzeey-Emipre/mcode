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
import { StackedLayersIcon } from "@/components/ui/StackedLayersIcon";

const COMMAND_ICONS = {
  goal: Target,
  plan: ListTodo,
  ultra: Gauge,
  compact: Minimize2,
};

const ENTITY_ICONS = {
  skill: BadgeCheck,
  plugin: Plug,
  mcode: Zap,
  command: SquareTerminal,
};

function getEntityIcon(kind: EntityKind, commandName: string | undefined) {
  if (kind === "command" || kind === "mcode") {
    return COMMAND_ICONS[commandName as keyof typeof COMMAND_ICONS] ?? ENTITY_ICONS[kind];
  }
  return ENTITY_ICONS[kind as keyof typeof ENTITY_ICONS] ?? SquareTerminal;
}

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

  const Icon = getEntityIcon(kind, commandName);

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
  tone: _tone = "assistant",
  invocation = false,
  className,
  ...props
}: EntityTokenProps) {
  const isCommandInvocation = kind === "command" || invocation;
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
        "text-primary",
        className,
      )}
      {...props}
    >
      <EntityIcon
        kind={kind}
        filePath={filePath}
        commandName={isCommandInvocation ? displayLabel : undefined}
        className="flex size-3.5 items-center justify-center text-current"
      />
      <span className="min-w-0 truncate">{displayLabel}</span>
    </span>
  );
}
