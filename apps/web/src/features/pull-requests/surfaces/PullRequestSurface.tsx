import { useCallback, useEffect, useRef, useState } from "react";
import { ResizableRightPanel } from "@/components/panels/ResizableRightPanel";
import { SidebarRevealButton } from "@/components/sidebar/SidebarRevealButton";
import { useElementWidth } from "@/hooks/useElementWidth";
import { cn } from "@/lib/utils";
import { usePullRequestDetailStore } from "@/features/pull-requests/state/pullRequestDetailStore";
import { usePullRequestStore } from "@/features/pull-requests/state/pullRequestStore";
import { useUiStore } from "@/stores/uiStore";
import type { PullRequestTransport } from "@/transport/pull-requests";
import {
  PullRequestDetailPane,
  type PullRequestDetailTab,
} from "./PullRequestDetailPane";
import { PullRequestInbox } from "./PullRequestInbox";

const MASTER_DETAIL_MIN_WIDTH = 880;
const INBOX_MIN_WIDTH = 360;
const INBOX_DEFAULT_WIDTH = 480;
const DETAIL_MIN_WIDTH = 520;

/** Props for the pull request master-detail surface. */
export interface PullRequestSurfaceProps {
  transport?: PullRequestTransport;
  /** History-controlled detail tab in the desktop shell. */
  activeTab?: PullRequestDetailTab;
  /** Reports direct detail-tab navigation to the desktop shell. */
  onActiveTabChange?: (tab: PullRequestDetailTab) => void;
  /** Uses desktop history for a contextual detail Back action. */
  onHistoryBack?: () => void;
}

/** Lazy-loaded top-level pull request inbox surface. */
export function PullRequestSurface({
  transport,
  activeTab,
  onActiveTabChange,
  onHistoryBack,
}: PullRequestSurfaceProps) {
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const showSidebarReveal = sidebarCollapsed && !window.desktopBridge;
  const activeKey = usePullRequestDetailStore((state) => state.activeKey);
  const activeSummary = usePullRequestStore((state) =>
    activeKey ? (state.entities[activeKey] ?? null) : null,
  );
  const surfaceRef = useRef<HTMLElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const detailBackButtonRef = useRef<HTMLButtonElement>(null);
  const originScrollTopRef = useRef(0);
  const [detailWidthOverride, setDetailWidthOverride] = useState<number | null>(
    null,
  );
  const width = useElementWidth(surfaceRef);
  const isWide = width >= MASTER_DETAIL_MIN_WIDTH;
  const isNarrow = !isWide;
  const detailMaxWidth = Math.max(DETAIL_MIN_WIDTH, width - INBOX_MIN_WIDTH);
  const defaultDetailWidth = Math.min(
    detailMaxWidth,
    Math.max(DETAIL_MIN_WIDTH, width - INBOX_DEFAULT_WIDTH),
  );
  const detailWidth = Math.min(
    detailMaxWidth,
    Math.max(DETAIL_MIN_WIDTH, detailWidthOverride ?? defaultDetailWidth),
  );

  useEffect(() => {
    usePullRequestDetailStore.getState().close(transport);
    return () => usePullRequestDetailStore.getState().close(transport);
  }, [transport]);

  const activateDetail = useCallback(
    (key: string) => {
      const selected = usePullRequestStore.getState().entities[key];
      if (!selected) return;
      originScrollTopRef.current = listboxRef.current?.scrollTop ?? 0;
      usePullRequestDetailStore.getState().open(selected.identity, transport);
      if (isNarrow) {
        requestAnimationFrame(() => detailBackButtonRef.current?.focus());
      }
    },
    [isNarrow, transport],
  );

  const closeDetail = useCallback(() => {
    usePullRequestDetailStore.getState().close(transport);
    requestAnimationFrame(() => {
      const listbox = listboxRef.current;
      if (!listbox) return;
      listbox.scrollTop = originScrollTopRef.current;
      listbox.focus();
    });
  }, [transport]);

  const getDetailMaxWidth = useCallback(
    () => Math.max(DETAIL_MIN_WIDTH, width - INBOX_MIN_WIDTH),
    [width],
  );

  const detailPane = activeKey ? (
    <PullRequestDetailPane
      identityKey={activeKey}
      summaryFallback={activeSummary}
      isNarrow={isNarrow}
      reserveSidebarReveal={showSidebarReveal && isNarrow}
      onClose={onHistoryBack ?? closeDetail}
      backButtonRef={detailBackButtonRef}
      transport={transport}
      activeTab={activeTab}
      onActiveTabChange={onActiveTabChange}
    />
  ) : null;

  return (
    <section
      ref={surfaceRef}
      aria-labelledby="pull-request-surface-title"
      data-layout={isWide ? "master-detail" : "narrow"}
      className="relative flex h-full min-h-0 flex-col bg-page"
    >
      {showSidebarReveal && (
        <div className="absolute left-3 top-3 z-10">
          <SidebarRevealButton />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div
          data-testid="pull-request-inbox-pane"
          hidden={isNarrow && Boolean(activeKey)}
          aria-hidden={isNarrow && Boolean(activeKey)}
          className={cn(
            "flex min-h-0 min-w-0 flex-col bg-page",
            !activeKey && isWide && "w-full",
            activeKey && isWide && "min-w-[360px] flex-1",
            isNarrow && "flex-1",
            isNarrow && activeKey && "hidden",
          )}
        >
          <PullRequestInbox
            transport={transport}
            onActivate={activateDetail}
            listboxRef={listboxRef}
            spacious={!activeKey}
            reserveSidebarReveal={showSidebarReveal}
          />
        </div>

        {activeKey && isWide ? (
          <ResizableRightPanel
            key={activeKey}
            testId="pull-request-detail-panel"
            width={detailWidth}
            minWidth={DETAIL_MIN_WIDTH}
            maxWidth={`calc(100% - ${INBOX_MIN_WIDTH}px)`}
            getMaxWidth={getDetailMaxWidth}
            defaultWidth={defaultDetailWidth}
            wideWidth={detailMaxWidth}
            separatorLabel="Resize pull request detail"
            onWidthChange={setDetailWidthOverride}
            className="flex shrink-0 overflow-hidden"
          >
            <div
              key={activeKey}
              data-testid="pull-request-detail-reveal"
              className="pull-request-detail-enter flex min-w-0 flex-1"
            >
              {detailPane}
            </div>
          </ResizableRightPanel>
        ) : activeKey ? (
          <div
            key={activeKey}
            data-testid="pull-request-detail-reveal"
            className="pull-request-detail-enter flex min-w-0 flex-1"
          >
            {detailPane}
          </div>
        ) : null}
      </div>
    </section>
  );
}
