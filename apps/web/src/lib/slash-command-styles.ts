import type { SlashCommandNamespace } from "@/components/chat/lexical/SlashCommandNode";

/**
 * Tailwind classes for inline slash-command chips (Lexical editor).
 * Background + ring per namespace.
 */
export const NAMESPACE_CHIP_STYLES: Record<SlashCommandNamespace, string> = {
  skill: "bg-emerald-500/25 ring-1 ring-emerald-500/40",
  mcode: "bg-primary/25 ring-1 ring-primary/40",
  plugin: "bg-orange-500/25 ring-1 ring-orange-500/40",
  command: "bg-sky-500/25 ring-1 ring-sky-500/40",
};

/**
 * Tailwind classes for namespace badges in the slash-command popup.
 * Background + text color per namespace.
 */
export const NAMESPACE_BADGE_STYLES: Record<SlashCommandNamespace, string> = {
  skill: "bg-muted text-muted-foreground",
  mcode: "bg-primary/20 text-primary",
  plugin: "bg-orange-500/20 text-orange-500",
  command: "bg-sky-500/20 text-sky-500",
};
