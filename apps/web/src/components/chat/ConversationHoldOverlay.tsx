import { Spinner } from "@/components/ui/spinner";

/** Props for {@link ConversationHoldOverlay}. */
interface ConversationHoldOverlayProps {
  /** Title of the selected thread that is loading behind the preserved transcript. */
  targetTitle: string;
}

/** Identifies a temporarily preserved outgoing transcript while the selected thread loads. */
export function ConversationHoldOverlay({ targetTitle }: ConversationHoldOverlayProps) {
  return (
    <div
      data-testid="conversation-hold-overlay"
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-10 flex items-center justify-center bg-background/45 backdrop-blur-[1px]"
    >
      <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
        <Spinner size={14} />
        <span>Switching to {targetTitle}</span>
      </div>
    </div>
  );
}
