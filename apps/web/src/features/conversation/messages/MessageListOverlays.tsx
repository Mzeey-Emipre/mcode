import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { StickyUserMessage } from "@/components/chat/StickyUserMessage";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import type { SelectedTextComment } from "@mcode/contracts";
import { useMemo, type RefObject } from "react";
import type { SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import type { Message } from "@/transport/types";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { SelectedTextCommentControls } from "./selection/SelectedTextCommentControls";
import type { SelectedTextCommentEditorScope } from "./selection/SelectedTextCommentControls";
import { SelectedTextCommentMarkers } from "./selection/SelectedTextCommentMarkers";

/** Props for transcript controls that float above the virtual rows. */
interface MessageListOverlaysProps {
  readonly handoffStatus: "generating" | "ready" | "fallback" | "error" | undefined;
  readonly messages: Message[];
  readonly isLoadingMore: boolean;
  readonly isLoadingNewer: boolean;
  readonly onSelectedTextComment: ((comment: SelectedTextComment) => void) | undefined;
  readonly onDeleteSelectedTextComment: ((comment: SelectedTextComment) => void) | undefined;
  readonly onSelectedTextCommentEditorChange:
    | ((editor: SelectedTextCommentEditorDraft | undefined) => void)
    | undefined;
  readonly selectedTextCommentEditor: SelectedTextCommentEditorDraft | undefined;
  readonly selectedTextCommentEditorScope: SelectedTextCommentEditorScope | undefined;
  readonly onOpenSelectedTextCommentEditor: ((comment: SelectedTextComment) => void) | undefined;
  /** Scroll viewport that bounds selected-text controls. */
  readonly viewportRef: RefObject<HTMLElement | null>;
  /** Thread whose transcript is currently rendered in the viewport. */
  readonly renderedThreadId: string | null | undefined;
  readonly stickyPreview: string | null;
  readonly isStickyVisible: boolean;
  readonly onJumpToLastUserMessage: () => void;
  readonly onStickyHeightChange: (height: number) => void;
  readonly showScrollToBottom: boolean;
  readonly hasNewContent: boolean;
  readonly onScrollToBottom: () => void;
}

function shouldShowHandoffSkeleton(status: MessageListOverlaysProps["handoffStatus"], messages: Message[]) {
  return status === "generating" && messages.filter((message) => message.role !== "system").length <= 1;
}

/** Renders transcript affordances that are independent of virtual row layout. */
export function MessageListOverlays({
  handoffStatus,
  messages,
  isLoadingMore,
  isLoadingNewer,
  onSelectedTextComment,
  onDeleteSelectedTextComment,
  onSelectedTextCommentEditorChange,
  selectedTextCommentEditor,
  selectedTextCommentEditorScope,
  onOpenSelectedTextCommentEditor,
  viewportRef,
  renderedThreadId,
  stickyPreview,
  isStickyVisible,
  onJumpToLastUserMessage,
  onStickyHeightChange,
  showScrollToBottom,
  hasNewContent,
  onScrollToBottom,
}: MessageListOverlaysProps) {
  const messageIds = useMemo(() => messages.map((message) => message.id), [messages]);

  return (
    <>
      {shouldShowHandoffSkeleton(handoffStatus, messages) && (
        <div className="px-4 py-4 sm:px-8">
          <div className={`${PRIMARY_CONTENT_RAIL_CLASS} space-y-2`}>
            <Skeleton className="h-3.5 w-3/4 animate-pulse rounded" />
            <Skeleton className="h-3.5 w-1/2 animate-pulse rounded" />
            <Skeleton className="h-3.5 w-2/3 animate-pulse rounded" />
          </div>
        </div>
      )}
      {isLoadingMore && <PaginationIndicator placement="top" />}
      {isLoadingNewer && <PaginationIndicator placement="bottom" />}
      {onSelectedTextComment && (
        <SelectedTextCommentControls
          key={renderedThreadId ?? "no-rendered-thread"}
          onSelectedTextComment={onSelectedTextComment}
          onDeleteSelectedTextComment={onDeleteSelectedTextComment}
          editor={selectedTextCommentEditor}
          onSelectedTextCommentEditorChange={onSelectedTextCommentEditorChange}
          selectedTextCommentEditorScope={selectedTextCommentEditorScope}
          viewportRef={viewportRef}
          renderedThreadId={renderedThreadId}
          messageIds={messageIds}
        />
      )}
      {onOpenSelectedTextCommentEditor && (
        <SelectedTextCommentMarkers
          viewportRef={viewportRef}
          renderedThreadId={renderedThreadId}
          editor={selectedTextCommentEditor}
          onOpenComment={onOpenSelectedTextCommentEditor}
        />
      )}
      {stickyPreview && (
        <StickyUserMessage
          preview={stickyPreview}
          visible={isStickyVisible}
          onJumpToMessage={onJumpToLastUserMessage}
          onHeightChange={onStickyHeightChange}
        />
      )}
      {showScrollToBottom && (
        <ScrollToBottomButton
          hasNewContent={hasNewContent}
          onScrollToBottom={onScrollToBottom}
        />
      )}
    </>
  );
}

/** Displays progress while directional message history is loading. */
function PaginationIndicator({ placement }: { readonly placement: "top" | "bottom" }) {
  const positionClass = placement === "top" ? "top-2" : "bottom-2";
  return (
    <div className={`absolute ${positionClass} left-1/2 z-10 -translate-x-1/2`}>
      <div className="rounded-md border border-border/40 bg-background/80 px-2 py-1 backdrop-blur-sm">
        <Spinner size={14} className="text-muted-foreground/70" />
      </div>
    </div>
  );
}
