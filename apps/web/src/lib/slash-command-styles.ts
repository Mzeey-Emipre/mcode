import type { SlashCommandNamespace } from "@/components/chat/lexical/SlashCommandNode";

/**
 * Tailwind classes for inline slash-command chips (Lexical editor).
 * Background + ring per namespace.
 */
export const NAMESPACE_CHIP_STYLES: Record<SlashCommandNamespace, string> = {
  skill: "bg-emerald-500/25 ring-1 ring-emerald-500/40",
  mcode: "bg-primary/25 ring-1 ring-primary/40",
  plugin: "bg-orange-500/25 ring-1 ring-orange-500/40",
  command: "bg-primary/25 ring-1 ring-primary/40",
};
