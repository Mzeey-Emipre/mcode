/**
 * Inline banner shown while the SDK is compacting the context window.
 *
 * Renders a pulsing amber dot with "Compacting context window..." text.
 * Appears in the same slot as AttachmentPreview, between the editor and controls row.
 */
export function CompactingBanner() {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 px-3 py-2 border-t border-border/20">
      {/* Pulsing ring to match the context tracker's visual language */}
      <span className="relative flex h-3 w-3 shrink-0">
        <span className="motion-safe:animate-ping motion-reduce:hidden absolute inline-flex h-full w-full rounded-full bg-amber-500/60" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500" />
      </span>
      <span className="text-xs text-muted-foreground">
        Compacting context window&hellip;
      </span>
    </div>
  );
}
