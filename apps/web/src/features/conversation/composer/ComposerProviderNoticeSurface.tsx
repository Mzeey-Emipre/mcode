import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronDown, Info, TriangleAlert, X } from "lucide-react";
import { ComposerOverlaySurface } from "@/components/chat/ComposerOverlaySurface";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useThreadRecord } from "../state";
import {
  getComposerProviderNotices,
  type ComposerProviderNotice,
} from "../notices/provider-notices";

function sameRect(a: DOMRect, b: DOMRect): boolean {
  return a.left === b.left
    && a.top === b.top
    && a.width === b.width
    && a.height === b.height;
}

function useComposerAnchor(
  composerContainerRef: RefObject<HTMLDivElement | null>,
): DOMRect | null {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const updateAnchor = useCallback(() => {
    const next = composerContainerRef.current?.getBoundingClientRect();
    if (!next) return;
    setAnchorRect((current) => current && sameRect(current, next) ? current : next);
  }, [composerContainerRef]);

  useLayoutEffect(() => {
    const composer = composerContainerRef.current;
    if (!composer) return;
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    const observer = new ResizeObserver(updateAnchor);
    for (let element: HTMLElement | null = composer; element; element = element.parentElement) {
      observer.observe(element);
    }
    return () => {
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
      observer.disconnect();
    };
  }, [composerContainerRef, updateAnchor]);

  return anchorRect;
}

function noticeIcon(tone: ComposerProviderNotice["tone"]) {
  return tone === "attention" ? TriangleAlert : Info;
}

function noticeRank(notice: ComposerProviderNotice): number {
  if (notice.tone === "attention") return 0;
  if (notice.tone === "informative") return 1;
  return 2;
}

interface ComposerProviderNoticeSurfaceProps {
  readonly threadId: string | undefined;
  readonly composerContainerRef: RefObject<HTMLDivElement | null>;
  readonly isMentionPickerOpen: boolean;
  readonly isSlashPickerOpen: boolean;
  /** Existing domain-owned content displayed above the provider notice. */
  readonly queue?: ReactNode;
  readonly hasQueue?: boolean;
  readonly children: (trigger: ReactNode) => ReactNode;
}

interface NoticeSurfaceState {
  readonly rankedNotices: readonly ComposerProviderNotice[];
  readonly selectedNotice: ComposerProviderNotice | undefined;
  readonly isManuallyOpen: boolean;
  readonly dismiss: () => void;
  readonly open: () => void;
  readonly showAnother: () => void;
}

interface ThreadNoticePresentation {
  readonly dismissedKeys: readonly string[];
  readonly manualSessionIdentity: string | undefined;
  readonly selectedKey: string | undefined;
}

const EMPTY_NOTICE_PRESENTATION: ThreadNoticePresentation = {
  dismissedKeys: [],
  manualSessionIdentity: undefined,
  selectedKey: undefined,
};

function selectNotices(
  notices: readonly ComposerProviderNotice[],
  dismissed: readonly string[],
  isManuallyOpen: boolean,
  selectedKey: string | undefined,
) {
  const automaticNotices = notices.filter((notice) => !dismissed.includes(notice.key));
  const rankedNotices = [...(isManuallyOpen ? notices : automaticNotices)]
    .sort((left, right) => noticeRank(left) - noticeRank(right));
  return {
    rankedNotices,
    selectedNotice: rankedNotices.find((notice) => notice.key === selectedKey) ?? rankedNotices[0],
  };
}

function useNoticeSurfaceState(
  threadId: string | undefined,
  sessionIdentity: string | undefined,
  notices: readonly ComposerProviderNotice[],
): NoticeSurfaceState {
  const [presentations, setPresentations] = useState<Record<string, ThreadNoticePresentation>>({});
  const presentation = threadId ? presentations[threadId] ?? EMPTY_NOTICE_PRESENTATION : EMPTY_NOTICE_PRESENTATION;
  const isManuallyOpen = sessionIdentity !== undefined
    && presentation.manualSessionIdentity === sessionIdentity;
  const { rankedNotices, selectedNotice } = selectNotices(
    notices,
    presentation.dismissedKeys,
    isManuallyOpen,
    presentation.selectedKey,
  );

  const dismiss = useCallback(() => {
    if (!threadId || !sessionIdentity || notices.length === 0) return;
    setPresentations((current) => ({
      ...current,
      [threadId]: {
        dismissedKeys: notices.map((notice) => notice.key),
        manualSessionIdentity: undefined,
        selectedKey: undefined,
      },
    }));
  }, [notices, sessionIdentity, threadId]);

  const open = useCallback(() => {
    if (!threadId || !sessionIdentity || notices.length === 0) return;
    setPresentations((current) => ({
      ...current,
      [threadId]: {
        ...(current[threadId] ?? EMPTY_NOTICE_PRESENTATION),
        manualSessionIdentity: sessionIdentity,
      },
    }));
  }, [notices.length, sessionIdentity, threadId]);

  const showAnother = useCallback(() => {
    if (!threadId || rankedNotices.length < 2 || !selectedNotice) return;
    const currentIndex = rankedNotices.findIndex((notice) => notice.key === selectedNotice.key);
    const next = rankedNotices[(currentIndex + 1) % rankedNotices.length];
    setPresentations((current) => ({
      ...current,
      [threadId]: {
        ...(current[threadId] ?? EMPTY_NOTICE_PRESENTATION),
        selectedKey: next.key,
      },
    }));
  }, [rankedNotices, selectedNotice, threadId]);

  return { rankedNotices, selectedNotice, isManuallyOpen, dismiss, open, showAnother };
}

function ComposerNoticeTrigger({
  hasNotices,
  showOverlay,
  onOpen,
}: {
  readonly hasNotices: boolean;
  readonly showOverlay: boolean;
  readonly onOpen: () => void;
}) {
  if (!hasNotices || showOverlay) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-7 gap-1 px-1.5 text-xs text-muted-foreground hover:bg-transparent"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onOpen}
            aria-label="Review provider notices"
          >
            <Info className="size-3.5" aria-hidden="true" />
            Review notices
          </Button>
        }
      />
      <TooltipContent>Review provider notices</TooltipContent>
    </Tooltip>
  );
}

function ComposerNoticeContent({
  notice,
  notices,
  detailsOpen,
  onDetailsChange,
  onShowAnother,
  onDismiss,
}: {
  readonly notice: ComposerProviderNotice;
  readonly notices: readonly ComposerProviderNotice[];
  readonly detailsOpen: boolean;
  readonly onDetailsChange: () => void;
  readonly onShowAnother: () => void;
  readonly onDismiss: () => void;
}) {
  const Icon = noticeIcon(notice.tone);
  return (
    <>
      <div className="flex min-w-0 items-center overflow-hidden hover:bg-muted/60 focus-within:bg-muted/60">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-10 min-w-0 flex-1 justify-start gap-2 rounded-none px-3 text-left text-xs hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent"
          aria-expanded={detailsOpen}
          aria-controls="composer-provider-notice-details"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onDetailsChange}
        >
          <Icon
            className={notice.tone === "attention" ? "size-3.5 text-amber-500" : "size-3.5 text-muted-foreground"}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">{notice.title}</span>
          <ChevronDown
            className={`size-3.5 text-muted-foreground transition-transform ${detailsOpen ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </Button>
        {notices.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-7 px-1.5 text-xs text-muted-foreground hover:bg-transparent dark:hover:bg-transparent"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onShowAnother}
          >
            Other notice
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="mr-1 rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
                aria-label="Dismiss notice"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onDismiss}
              >
                <X className="size-3.5" aria-hidden="true" />
              </Button>
            }
          />
          <TooltipContent>Hide notice</TooltipContent>
        </Tooltip>
      </div>
      {detailsOpen && (
        <div id="composer-provider-notice-details" className="border-t border-border/60 px-3 py-2.5 text-xs">
          <p className="break-words text-muted-foreground">{notice.details}</p>
          {notice.location && <p className="mt-1 break-all font-mono text-muted-foreground">{notice.location}</p>}
        </div>
      )}
    </>
  );
}

function shouldShowNoticeOverlay({
  anchorRect,
  sessionIdentity,
  selectedNotice,
  isPickerOpen,
  isManuallyOpen,
  hasAutomaticNotice,
}: {
  readonly anchorRect: DOMRect | null;
  readonly sessionIdentity: string | undefined;
  readonly selectedNotice: ComposerProviderNotice | undefined;
  readonly isPickerOpen: boolean;
  readonly isManuallyOpen: boolean;
  readonly hasAutomaticNotice: boolean;
}): boolean {
  return Boolean(anchorRect && sessionIdentity && selectedNotice && !isPickerOpen
    && (isManuallyOpen || hasAutomaticNotice));
}

function shouldRenderComposerNoticeOverlay(
  isPickerOpen: boolean,
  hasQueue: boolean,
  showOverlay: boolean,
  anchorRect: DOMRect | null,
): anchorRect is DOMRect {
  return !isPickerOpen && (hasQueue || showOverlay) && anchorRect !== null;
}

function estimatedComposerOverlayHeight(hasQueue: boolean, detailsOpen: boolean): number {
  if (hasQueue) return detailsOpen ? 424 : 312;
  return detailsOpen ? 152 : 40;
}

/** Shows loaded provider notices above Composer without affecting editor or picker controls. */
export function ComposerProviderNoticeSurface({
  threadId,
  composerContainerRef,
  isMentionPickerOpen,
  isSlashPickerOpen,
  queue,
  hasQueue = false,
  children,
}: ComposerProviderNoticeSurfaceProps) {
  const sessionNotices = useThreadRecord(threadId, (record) => record.sessionNotices);
  const noticeSessionId = useThreadRecord(threadId, (record) => record.noticeSessionId);
  const notices = useMemo(
    () => getComposerProviderNotices(sessionNotices, noticeSessionId),
    [noticeSessionId, sessionNotices],
  );
  const anchorRect = useComposerAnchor(composerContainerRef);
  const sessionIdentity = notices.at(-1)?.sessionIdentity;
  const [details, setDetails] = useState({ sessionIdentity: undefined as string | undefined, open: false });
  const detailsOpen = details.sessionIdentity === sessionIdentity && details.open;
  const noticeState = useNoticeSurfaceState(threadId, sessionIdentity, notices);
  const isPickerOpen = isMentionPickerOpen || isSlashPickerOpen;
  const hasAutomaticNotice = noticeState.rankedNotices.some((notice) => notice.tone !== "quiet");
  const showOverlay = shouldShowNoticeOverlay({
    anchorRect,
    sessionIdentity,
    selectedNotice: noticeState.selectedNotice,
    isPickerOpen,
    isManuallyOpen: noticeState.isManuallyOpen,
    hasAutomaticNotice,
  });

  const dismiss = () => {
    noticeState.dismiss();
    setDetails({ sessionIdentity, open: false });
  };
  const open = () => {
    noticeState.open();
    setDetails({ sessionIdentity, open: true });
  };
  const showAnother = () => {
    noticeState.showAnother();
    setDetails({ sessionIdentity, open: true });
  };

  return (
    <>
      {children(
        <ComposerNoticeTrigger
          hasNotices={notices.length > 0 && sessionIdentity !== undefined}
          showOverlay={showOverlay}
          onOpen={open}
        />,
      )}
      {shouldRenderComposerNoticeOverlay(isPickerOpen, hasQueue, showOverlay, anchorRect) && (
        <ComposerOverlaySurface
          anchorRect={anchorRect}
          estimatedHeight={estimatedComposerOverlayHeight(hasQueue, detailsOpen)}
          attached
          className="composer-provider-notice-surface max-h-[calc(100vh-5rem)] overflow-y-auto"
          data-testid="composer-provider-notice"
        >
          {hasQueue && (
            <div className="max-h-72 p-1">
              {queue}
            </div>
          )}
          {showOverlay && noticeState.selectedNotice && (
            <ComposerNoticeContent
              notice={noticeState.selectedNotice}
              notices={noticeState.rankedNotices}
              detailsOpen={detailsOpen}
              onDetailsChange={() => setDetails((current) => ({
                sessionIdentity,
                open: current.sessionIdentity === sessionIdentity ? !current.open : true,
              }))}
              onShowAnother={showAnother}
              onDismiss={dismiss}
            />
          )}
        </ComposerOverlaySurface>
      )}
    </>
  );
}
