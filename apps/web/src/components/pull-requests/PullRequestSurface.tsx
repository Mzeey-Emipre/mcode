import { useCallback, useEffect, useRef } from "react";
import { SidebarRevealButton } from "@/components/sidebar/SidebarRevealButton";
import { useElementWidth } from "@/hooks/useElementWidth";
import { cn } from "@/lib/utils";
import { usePullRequestDetailStore } from "@/stores/pullRequestDetailStore";
import { usePullRequestStore } from "@/stores/pullRequestStore";
import { useUiStore } from "@/stores/uiStore";
import type { PullRequestTransport } from "@/transport/pull-requests";
import { PullRequestDetailPane } from "./PullRequestDetailPane";
import { PullRequestInbox } from "./PullRequestInbox";

const MASTER_DETAIL_MIN_WIDTH = 880;

/** Props for the pull request master-detail surface. */
export interface PullRequestSurfaceProps {
  transport?: PullRequestTransport;
}

/** Lazy-loaded top-level pull request inbox surface. */
export function PullRequestSurface({ transport }: PullRequestSurfaceProps) {
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const activeKey = usePullRequestDetailStore((state) => state.activeKey);
  const activeSummary = usePullRequestStore((state) =>
    activeKey ? (state.entities[activeKey] ?? null) : null,
  );
  const surfaceRef = useRef<HTMLElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const detailBackButtonRef = useRef<HTMLButtonElement>(null);
  const originScrollTopRef = useRef(0);
  const width = useElementWidth(surfaceRef);
  const isWide = width >= MASTER_DETAIL_MIN_WIDTH;
  const isNarrow = !isWide;

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

  return (
    <section
      ref={surfaceRef}
      aria-labelledby="pull-request-surface-title"
      data-layout={isWide ? "master-detail" : "narrow"}
      className="relative flex h-full min-h-0 flex-col bg-page"
    >
      {sidebarCollapsed && (
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
            activeKey && isWide && "min-w-[360px] max-w-[520px] shrink-0",
            isNarrow && "flex-1",
            isNarrow && activeKey && "hidden",
          )}
          style={
            activeKey && isWide
              ? { flexBasis: "calc(100% - 540px)" }
              : undefined
          }
        >
          <PullRequestInbox
            transport={transport}
            onActivate={activateDetail}
            listboxRef={listboxRef}
            spacious={!activeKey}
            reserveSidebarReveal={sidebarCollapsed}
          />
        </div>

        {activeKey ? (
          <div className="flex min-w-0 flex-1 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 motion-safe:duration-200">
            <PullRequestDetailPane
              identityKey={activeKey}
              summaryFallback={activeSummary}
              isNarrow={isNarrow}
              reserveSidebarReveal={sidebarCollapsed && isNarrow}
              onClose={closeDetail}
              backButtonRef={detailBackButtonRef}
              transport={transport}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
