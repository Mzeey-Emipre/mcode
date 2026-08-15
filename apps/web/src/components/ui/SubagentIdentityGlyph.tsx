import type { CSSProperties, ComponentProps } from "react";
import { StackedLayersIcon } from "./StackedLayersIcon";
import { cn } from "@/lib/utils";

const IDENTITY_PALETTE_SIZE = 5;

/** Returns the locale-independent bounded palette slot for one subagent identity. */
export function getSubagentIdentityPaletteIndex(identity: string): number {
  let hash = 0;
  for (const character of identity.trim().toLowerCase()) {
    hash = ((hash << 5) - hash + character.codePointAt(0)!) | 0;
  }
  return Math.abs(hash) % IDENTITY_PALETTE_SIZE;
}

/** Props for the shared identity-colored subagent glyph. */
export interface SubagentIdentityGlyphProps extends ComponentProps<"span"> {
  /** Display identity used to choose one color from the bounded palette. */
  identity: string;
  /** Whether the identity came from explicit provider or persisted metadata. */
  hasExplicitIdentity: boolean;
  /** Whether the stacked-layers silhouette should animate for active work. */
  animated?: boolean;
  /** Pixel size of the stacked-layers silhouette. */
  size?: number;
}

/** Renders the shared identity-colored subagent silhouette. */
export function SubagentIdentityGlyph({
  identity,
  hasExplicitIdentity,
  animated = false,
  size = 14,
  className,
  style,
  ...props
}: SubagentIdentityGlyphProps) {
  const paletteIndex = hasExplicitIdentity
    ? getSubagentIdentityPaletteIndex(identity)
    : undefined;
  return (
    <span
      data-subagent-identity-glyph={identity}
      data-subagent-palette={paletteIndex}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md",
        hasExplicitIdentity
          ? "subagent-identity-glyph"
          : "bg-muted/65 text-muted-foreground ring-1 ring-inset ring-border/60",
        className,
      )}
      style={hasExplicitIdentity
        ? {
            "--subagent-identity-color": `var(--subagent-identity-${paletteIndex! + 1})`,
            ...style,
          } as CSSProperties
        : style}
      {...props}
    >
      <StackedLayersIcon animated={animated} style={{ width: size, height: size }} />
    </span>
  );
}
