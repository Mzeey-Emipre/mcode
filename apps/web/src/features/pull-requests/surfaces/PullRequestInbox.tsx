import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Key, KeyboardEvent, ReactNode, RefObject, MutableRefObject } from "react";
import type { PullRequestError, PullRequestState } from "@mcode/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import type { PullRequestTransport } from "@/transport/pull-requests";
import { cn } from "@/lib/utils";
import {
  buildPullRequestInboxListItems,
  filterPullRequestKeys,
  selectPullRequestHasNextPage,
  selectTeamRequestLimitation,
} from "@/features/pull-requests/state/pull-request-selectors";
import type { PullRequestInboxListItem } from "@/features/pull-requests/state/pull-request-selectors";
import {
  usePullRequestStore,
  type PullRequestInboxRelationship,
  type PullRequestInboxStatus,
} from "@/features/pull-requests/state/pullRequestStore";
import { PullRequestFilters } from "./PullRequestFilters";
import { getPullRequestRowDomId, PullRequestRow } from "./PullRequestRow";

const ROW_ESTIMATE_PX = 72;
const GROUP_HEADER_ESTIMATE_PX = 40;
const VIRTUALIZE_THRESHOLD = 30;
const OVERSCAN = 4;
const BACKGROUND_REFRESH_MS = 120_000;
const RELATIONSHIP_TABS = ["all", "reviewing", "authored"] as const;
const STATE_FILTERS = ["open", "closed", "merged"] as const;
const RELATIONSHIP_PANEL_ID = "pull-request-relationship-panel";

function relationshipTabId(tab: PullRequestInboxRelationship): string {
  return `pull-request-relationship-tab-${tab}`;
}

function estimateListItemSize(item: PullRequestInboxListItem): number {
  return item.type === "header" ? GROUP_HEADER_ESTIMATE_PX : ROW_ESTIMATE_PX;
}

function nextRowKey(
  key: string,
  selectedKey: string | null,
  rowKeys: string[],
): string | null {
  if (rowKeys.length === 0) return null;
  const currentIndex = selectedKey ? rowKeys.indexOf(selectedKey) : -1;
  const nextIndex = rowNavigationIndex(key, currentIndex, rowKeys.length);
  return nextIndex === null ? null : (rowKeys[nextIndex] ?? null);
}

function rowNavigationIndex(
  key: string,
  currentIndex: number,
  rowCount: number,
): number | null {
  if (key === "ArrowDown") return Math.min(rowCount - 1, currentIndex + 1);
  if (key === "ArrowUp") return Math.max(0, currentIndex - 1);
  if (key === "Home") return 0;
  if (key === "End") return Math.max(0, rowCount - 1);
  return null;
}

/** Props for the pull request inbox viewport. */
export interface PullRequestInboxProps {
  autoLoad?: boolean;
  transport?: PullRequestTransport;
  onActivate?: (identityKey: string) => void;
  listboxRef?: RefObject<HTMLDivElement | null>;
  spacious?: boolean;
  reserveSidebarReveal?: boolean;
}

function teamLimitationMessage(reason: string): string {
  if (reason === "missing_scope") {
    return "Team review requests are unavailable because the GitHub scope is missing.";
  }
  if (reason === "unauthenticated") {
    return "Team review requests are unavailable until GitHub is authenticated.";
  }
  return "Team review requests are unavailable for this GitHub connection.";
}

function inboxEmptyLabel(orderedKeys: string[]): string {
  return orderedKeys.length === 0 ? "No pull requests" : "No matches";
}

function inboxSurfaceClassName(spacious: boolean): string {
  return cn("flex min-h-0 flex-1 flex-col bg-page", spacious && "items-center");
}

function PullRequestInboxHeading({
  viewerLogin,
  reserveSidebarReveal,
}: {
  viewerLogin: string | undefined;
  reserveSidebarReveal: boolean;
}) {
  return (
    <div
      data-testid="pull-request-inbox-heading-column"
      className={cn(
        "mx-auto w-full max-w-[720px] shrink-0 px-5 pb-5 pt-8 lg:pt-16",
        reserveSidebarReveal && "max-lg:pl-14 max-lg:pt-4",
      )}
    >
      <h1 id="pull-request-surface-title" className="text-xl font-medium tracking-tight text-foreground">
        Pull requests
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Review and track work across {viewerLogin ?? "GitHub"}.
      </p>
    </div>
  );
}

function PullRequestInboxToolbar({
  relationship,
  states,
  status,
  relationshipTabRefs,
  onRelationshipChange,
  onRelationshipTabKeyDown,
  onStatesChange,
  onRefresh,
}: {
  relationship: PullRequestInboxRelationship;
  states: PullRequestState[];
  status: PullRequestInboxStatus;
  relationshipTabRefs: MutableRefObject<Array<HTMLButtonElement | null>>;
  onRelationshipChange: (relationship: PullRequestInboxRelationship) => void;
  onRelationshipTabKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
  onStatesChange: (states: PullRequestState[]) => void;
  onRefresh: () => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Pull request relationships"
      className="mx-auto mb-3 mt-5 flex h-9 w-full max-w-[720px] shrink-0 items-center gap-1 px-5"
    >
      {RELATIONSHIP_TABS.map((tab, index) => (
        <Button
          key={tab}
          ref={(node) => { relationshipTabRefs.current[index] = node; }}
          id={relationshipTabId(tab)}
          type="button"
          role="tab"
          aria-selected={relationship === tab}
          aria-controls={RELATIONSHIP_PANEL_ID}
          tabIndex={relationship === tab ? 0 : -1}
          variant="ghost"
          size="sm"
          onClick={() => onRelationshipChange(tab)}
          onKeyDown={(event) => onRelationshipTabKeyDown(event, index)}
          className={cn(
            "relative h-8 rounded-none px-2 text-xs font-medium capitalize after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:origin-center after:bg-primary after:transition-transform after:duration-200 after:ease-out motion-reduce:after:transition-none",
            relationship === tab
              ? "text-foreground after:scale-x-100"
              : "text-muted-foreground after:scale-x-0 hover:text-foreground",
          )}
        >
          {tab}
        </Button>
      ))}
      <div role="group" aria-label="Pull request state" className="ml-auto flex items-center gap-0.5">
        {STATE_FILTERS.map((state) => (
          <PullRequestStateFilter
            key={state}
            state={state}
            selected={states.length === 1 && states[0] === state}
            onSelect={onStatesChange}
          />
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Refresh pull requests"
        onClick={onRefresh}
        className="ml-1 text-muted-foreground"
      >
        {status === "refreshing" ? <Spinner size="sm" /> : <RefreshCw size={13} aria-hidden />}
      </Button>
    </div>
  );
}

function PullRequestStateFilter({
  state,
  selected,
  onSelect,
}: {
  state: PullRequestState;
  selected: boolean;
  onSelect: (states: PullRequestState[]) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-pressed={selected}
      className={cn(
        "h-8 px-2 text-xs font-normal capitalize",
        selected ? "bg-muted/70 text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
      onClick={() => onSelect([state])}
    >
      {state}
    </Button>
  );
}

function PullRequestInboxPanel({
  relationship,
  hasSwitchedRelationship,
  teamLimitation,
  stale,
  error,
  loadingEmpty,
  errorEmpty,
  emptyLabel,
  hasRows,
  hasNextPage,
  status,
  onRefresh,
  onLoadMore,
  children,
}: {
  relationship: PullRequestInboxRelationship;
  hasSwitchedRelationship: boolean;
  teamLimitation: string | null;
  stale: boolean;
  error: PullRequestError | null;
  loadingEmpty: boolean;
  errorEmpty: boolean;
  emptyLabel: string;
  hasRows: boolean;
  hasNextPage: boolean;
  status: PullRequestInboxStatus;
  onRefresh: () => void;
  onLoadMore: () => void;
  children: ReactNode;
}) {
  return (
    <div
      key={relationship}
      id={RELATIONSHIP_PANEL_ID}
      role="tabpanel"
      aria-labelledby={relationshipTabId(relationship)}
      className={cn("flex min-h-0 w-full flex-1 flex-col", hasSwitchedRelationship && "pull-request-relationship-enter")}
    >
      <PullRequestInboxNotices teamLimitation={teamLimitation} stale={stale} error={error} onRefresh={onRefresh} />
      <PullRequestInboxBody
        loadingEmpty={loadingEmpty}
        errorEmpty={errorEmpty}
        error={error}
        emptyLabel={emptyLabel}
        hasRows={hasRows}
        onRefresh={onRefresh}
      >
        {children}
      </PullRequestInboxBody>
      {hasRows && hasNextPage ? <PullRequestInboxLoadMore status={status} onLoadMore={onLoadMore} /> : null}
    </div>
  );
}

function PullRequestInboxNotices({
  teamLimitation,
  stale,
  error,
  onRefresh,
}: {
  teamLimitation: string | null;
  stale: boolean;
  error: PullRequestError | null;
  onRefresh: () => void;
}) {
  return (
    <>
      {teamLimitation ? (
        <div className="mx-auto w-full max-w-[720px] px-5">
          <p className="mb-2 flex items-start gap-2 bg-muted/35 px-2.5 py-2 text-xs text-muted-foreground">
            <AlertCircle size={13} aria-hidden className="mt-0.5 shrink-0 text-primary/80" />
            {teamLimitationMessage(teamLimitation)}
          </p>
        </div>
      ) : null}
      {stale && error ? (
        <div className="mx-auto w-full max-w-[720px] px-5">
          <div className="mb-2 flex items-center gap-2 bg-destructive/10 px-2.5 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">Stale data. {error.message}</span>
            <Button type="button" variant="ghost" size="xs" onClick={onRefresh} className="h-6">Retry</Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function PullRequestInboxBody({
  loadingEmpty,
  errorEmpty,
  error,
  emptyLabel,
  hasRows,
  onRefresh,
  children,
}: {
  loadingEmpty: boolean;
  errorEmpty: boolean;
  error: PullRequestError | null;
  emptyLabel: string;
  hasRows: boolean;
  onRefresh: () => void;
  children: ReactNode;
}) {
  if (loadingEmpty) {
    return <div className="flex flex-1 items-center justify-center text-muted-foreground"><Spinner size="sm" aria-label="Loading pull requests" /></div>;
  }
  if (errorEmpty) {
    return <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"><AlertCircle size={22} aria-hidden className="text-destructive/70" /><p className="text-sm text-foreground">{error?.message ?? "Pull request read failed"}</p><Button type="button" variant="outline" size="sm" onClick={onRefresh}>Retry</Button></div>;
  }
  if (!hasRows) {
    return <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground"><span aria-hidden className="font-mono text-3xl opacity-35">∅</span><p className="font-mono text-xs uppercase tracking-widest">{emptyLabel}</p></div>;
  }
  return children;
}

function PullRequestInboxLoadMore({ status, onLoadMore }: { status: PullRequestInboxStatus; onLoadMore: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[720px] shrink-0 px-5 py-2">
      <Button type="button" variant="ghost" size="sm" onClick={onLoadMore} disabled={status === "refreshing"} className="w-full text-xs text-muted-foreground">
        Load more
      </Button>
    </div>
  );
}

function PullRequestInboxList({
  viewportRef,
  selectedKey,
  mountedRowKeys,
  onKeyDown,
  shouldVirtualize,
  virtualizer,
  visibleItems,
  listItems,
  renderListItem,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  selectedKey: string | null;
  mountedRowKeys: Set<string>;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  shouldVirtualize: boolean;
  virtualizer: { getTotalSize: () => number };
  visibleItems: Array<{ index: number; key: Key; start: number }>;
  listItems: PullRequestInboxListItem[];
  renderListItem: (item: PullRequestInboxListItem) => ReactNode;
}) {
  return (
    <ScrollArea
      className="min-h-0 w-full flex-1"
      viewportRef={viewportRef}
      viewportProps={{
        role: "listbox",
        tabIndex: 0,
        "aria-label": "Pull requests",
        "aria-activedescendant":
          selectedKey && mountedRowKeys.has(selectedKey)
            ? getPullRequestRowDomId(selectedKey)
            : undefined,
        onKeyDown,
      }}
    >
      <div
        role="presentation"
        data-testid="pull-request-list-content"
        className="relative mx-auto min-h-full w-full max-w-[720px]"
        style={
          shouldVirtualize
            ? {
                height: virtualizer.getTotalSize(),
                contain: "layout paint style",
              }
            : undefined
        }
      >
        {shouldVirtualize
          ? visibleItems.map((virtualItem) => {
              const item = listItems[virtualItem.index];
              if (!item) return null;
              return (
                <div
                  key={virtualItem.key}
                  role="presentation"
                  data-index={virtualItem.index}
                  className="absolute left-0 w-full"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {renderListItem(item)}
                </div>
              );
            })
          : listItems.map((item) => (
              <div key={item.key} role="presentation">
                {renderListItem(item)}
              </div>
            ))}
      </div>
    </ScrollArea>
  );
}

/** Virtualized, keyboard-accessible pull request inbox. */
export function PullRequestInbox({
  autoLoad = true,
  transport,
  onActivate,
  listboxRef,
  spacious = false,
  reserveSidebarReveal = false,
}: PullRequestInboxProps) {
  const relationship = usePullRequestStore((state) => state.relationship);
  const states = usePullRequestStore((state) => state.states);
  const viewer = usePullRequestStore((state) => state.viewer);
  const storeSearch = usePullRequestStore((state) => state.search);
  const orderedKeys = usePullRequestStore((state) => state.orderedKeys);
  const entities = usePullRequestStore((state) => state.entities);
  const repositoryFilter = usePullRequestStore(
    (state) => state.repositoryFilter,
  );
  const authorFilter = usePullRequestStore((state) => state.authorFilter);
  const reviewFilters = usePullRequestStore((state) => state.reviewFilters);
  const checkFilters = usePullRequestStore((state) => state.checkFilters);
  const selectedKey = usePullRequestStore((state) => state.selectedKey);
  const status = usePullRequestStore((state) => state.status);
  const error = usePullRequestStore((state) => state.error);
  const stale = usePullRequestStore((state) => state.stale);
  const hasNextPage = usePullRequestStore(selectPullRequestHasNextPage);
  const teamLimitation = usePullRequestStore(selectTeamRequestLimitation);
  const [search, setSearch] = useState(storeSearch);
  const [hasSwitchedRelationship, setHasSwitchedRelationship] = useState(false);
  const internalViewportRef = useRef<HTMLDivElement>(null);
  const viewportRef = listboxRef ?? internalViewportRef;
  const relationshipTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visibleKeys = useMemo(
    () =>
      filterPullRequestKeys({
        orderedKeys,
        entities,
        repositoryFilter,
        authorFilter,
        reviewFilters,
        checkFilters,
        search,
      }),
    [
      authorFilter,
      checkFilters,
      entities,
      orderedKeys,
      repositoryFilter,
      reviewFilters,
      search,
    ],
  );
  const repositories = useMemo(
    () =>
      Array.from(
        new Set(
          orderedKeys.flatMap((key) => {
            const item = entities[key];
            return item
              ? [`${item.identity.owner}/${item.identity.repository}`]
              : [];
          }),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [entities, orderedKeys],
  );
  const authors = useMemo(
    () =>
      Array.from(
        new Set(
          orderedKeys.flatMap((key) => {
            const item = entities[key];
            return item ? [item.author?.login ?? "unknown"] : [];
          }),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [entities, orderedKeys],
  );
  const listItems = useMemo(
    () => buildPullRequestInboxListItems(relationship, visibleKeys, entities),
    [entities, relationship, visibleKeys],
  );
  const rowKeys = useMemo(
    () => listItems.flatMap((item) => (item.type === "row" ? [item.key] : [])),
    [listItems],
  );
  const rowPositionByKey = useMemo(
    () => new Map(rowKeys.map((key, index) => [key, index + 1])),
    [rowKeys],
  );
  const estimatedOffsets = useMemo(() => {
    let offset = 0;
    return listItems.map((item) => {
      const start = offset;
      offset += estimateListItemSize(item);
      return start;
    });
  }, [listItems]);
  const shouldVirtualize = listItems.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: listItems.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) => {
      const item = listItems[index];
      return item ? estimateListItemSize(item) : ROW_ESTIMATE_PX;
    },
    getItemKey: (index) => listItems[index]?.key ?? String(index),
    overscan: OVERSCAN,
    useFlushSync: false,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const visibleItems = useMemo(() => {
    if (!shouldVirtualize) return [];
    if (virtualItems.length > 0) return virtualItems;
    const visibleCount = Math.min(
      listItems.length,
      Math.max(
        1,
        Math.ceil(
          (viewportRef.current?.clientHeight ?? ROW_ESTIMATE_PX) /
            ROW_ESTIMATE_PX,
        ) +
          OVERSCAN * 2,
      ),
    );
    return Array.from({ length: visibleCount }, (_, index) => ({
      index,
      key: listItems[index]?.key ?? String(index),
      start: estimatedOffsets[index] ?? 0,
      size: listItems[index]
        ? estimateListItemSize(listItems[index])
        : ROW_ESTIMATE_PX,
      end:
        (estimatedOffsets[index] ?? 0) +
        (listItems[index]
          ? estimateListItemSize(listItems[index])
          : ROW_ESTIMATE_PX),
      lane: 0,
    }));
  }, [estimatedOffsets, listItems, shouldVirtualize, virtualItems]);
  const mountedRowKeys = useMemo(() => {
    if (!shouldVirtualize) return new Set(rowKeys);
    return new Set(
      visibleItems.flatMap((virtualItem) => {
        const item = listItems[virtualItem.index];
        return item?.type === "row" ? [item.key] : [];
      }),
    );
  }, [listItems, rowKeys, shouldVirtualize, visibleItems]);

  const refresh = useCallback(() => {
    void usePullRequestStore.getState().loadFirstPage(transport);
  }, [transport]);

  useEffect(() => {
    if (!autoLoad) return;
    const store = usePullRequestStore.getState();
    let mounted = true;
    void store.loadCapabilities(transport).then((capabilitiesLoaded) => {
      if (!mounted || !capabilitiesLoaded) return;
      void usePullRequestStore.getState().loadFirstPage(transport);
    });
    return () => {
      mounted = false;
      void usePullRequestStore.getState().cancelActive(transport);
    };
  }, [autoLoad, transport]);

  useEffect(() => {
    if (!autoLoad) return;
    const isActive = () =>
      document.visibilityState === "visible" && document.hasFocus();
    let active = isActive();
    let intervalId: number | null = null;
    const clearPolling = () => {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };
    const armPolling = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {
        if (isActive()) {
          void usePullRequestStore.getState().refreshIfStale(transport);
        }
      }, BACKGROUND_REFRESH_MS);
    };
    const handleActivityChange = () => {
      const nextActive = isActive();
      if (nextActive === active) return;
      active = nextActive;
      if (!active) {
        clearPolling();
        return;
      }
      armPolling();
      void usePullRequestStore.getState().refreshIfStale(transport);
    };
    if (active) armPolling();
    window.addEventListener("focus", handleActivityChange);
    window.addEventListener("blur", handleActivityChange);
    document.addEventListener("visibilitychange", handleActivityChange);
    return () => {
      window.removeEventListener("focus", handleActivityChange);
      window.removeEventListener("blur", handleActivityChange);
      document.removeEventListener("visibilitychange", handleActivityChange);
      clearPolling();
    };
  }, [autoLoad, transport]);

  const changeRelationship = (next: PullRequestInboxRelationship) => {
    if (next !== relationship) setHasSwitchedRelationship(true);
    const store = usePullRequestStore.getState();
    const canReuseLoadedRows =
      store.loadedRelationship === "all" || store.loadedRelationship === next;
    store.setRelationship(next);
    if (canReuseLoadedRows) {
      void store.refreshIfStale(transport);
      return;
    }
    refresh();
  };

  const handleRelationshipTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % RELATIONSHIP_TABS.length;
    }
    if (event.key === "ArrowLeft") {
      nextIndex =
        (index - 1 + RELATIONSHIP_TABS.length) % RELATIONSHIP_TABS.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = RELATIONSHIP_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    relationshipTabRefs.current[nextIndex]?.focus();
    const next = RELATIONSHIP_TABS[nextIndex];
    if (next) changeRelationship(next);
  };

  const changeStates = (next: PullRequestState[]) => {
    usePullRequestStore.getState().setStates(next);
    refresh();
  };

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const normalized = search.trim().slice(0, 200);
      const store = usePullRequestStore.getState();
      if (store.search !== normalized) store.setSearch(search);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    if (rowKeys.length === 0) {
      if (selectedKey !== null)
        usePullRequestStore.getState().setSelectedKey(null);
      return;
    }
    if (!selectedKey || !rowKeys.includes(selectedKey)) {
      usePullRequestStore.getState().setSelectedKey(rowKeys[0] ?? null);
    }
  }, [rowKeys, selectedKey]);

  const scrollSelectedRowIntoView = (nextKey: string): void => {
    if (!shouldVirtualize) return;
    const listItemIndex = listItems.findIndex(
      (item) => item.type === "row" && item.key === nextKey,
    );
    if (listItemIndex >= 0) {
      virtualizer.scrollToIndex(listItemIndex, { align: "auto" });
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && selectedKey) {
      event.preventDefault();
      onActivate?.(selectedKey);
      return;
    }
    const nextKey = nextRowKey(event.key, selectedKey, rowKeys);
    if (!nextKey) return;
    event.preventDefault();
    usePullRequestStore.getState().setSelectedKey(nextKey);
    scrollSelectedRowIntoView(nextKey);
  };

  const loadingEmpty =
    ((autoLoad && status === "idle") || status === "loading") &&
    orderedKeys.length === 0;
  const errorEmpty = status === "error" && orderedKeys.length === 0;

  const renderListItem = (item: PullRequestInboxListItem) => {
    if (item.type === "row") {
      return (
        <PullRequestRow
          identityKey={item.key}
          onSelect={onActivate}
          describedBy={item.describedBy}
          positionInSet={rowPositionByKey.get(item.key)}
          setSize={rowKeys.length}
        />
      );
    }
    return (
      <div
        id={item.id}
        role="presentation"
        data-testid="pull-request-group-header"
        data-group={item.label}
        className="flex h-10 items-center px-5 text-xs font-medium text-muted-foreground"
      >
        <span>{item.label}</span>
      </div>
    );
  };

  const loadNextPage = () => {
    void usePullRequestStore.getState().loadNextPage(transport);
  };

  return (
    <div className={inboxSurfaceClassName(spacious)}>
      <PullRequestInboxHeading
        viewerLogin={viewer?.login}
        reserveSidebarReveal={reserveSidebarReveal}
      />
      <div
        data-testid="pull-request-inbox-filter-column"
        className="mx-auto w-full max-w-[720px] shrink-0 px-5"
      >
        <PullRequestFilters
          search={search}
          states={states}
          repositories={repositories}
          authors={authors}
          repositoryFilter={repositoryFilter}
          authorFilter={authorFilter}
          reviewFilters={reviewFilters}
          checkFilters={checkFilters}
          onSearchChange={setSearch}
          onStatesChange={changeStates}
          onRepositoryChange={(repository) =>
            usePullRequestStore.getState().setRepositoryFilter(repository)
          }
          onAuthorChange={(author) =>
            usePullRequestStore.getState().setAuthorFilter(author)
          }
          onReviewToggle={(review) =>
            usePullRequestStore.getState().toggleReviewFilter(review)
          }
          onCheckToggle={(check) =>
            usePullRequestStore.getState().toggleCheckFilter(check)
          }
          onClearAll={() => {
            const store = usePullRequestStore.getState();
            store.clearLocalFilters();
            if (states.length !== 1 || states[0] !== "open") {
              store.setStates(["open"]);
              refresh();
            }
          }}
        />
      </div>
      <PullRequestInboxToolbar
        relationship={relationship}
        states={states}
        status={status}
        relationshipTabRefs={relationshipTabRefs}
        onRelationshipChange={changeRelationship}
        onRelationshipTabKeyDown={handleRelationshipTabKeyDown}
        onStatesChange={changeStates}
        onRefresh={refresh}
      />
      <PullRequestInboxPanel
        relationship={relationship}
        hasSwitchedRelationship={hasSwitchedRelationship}
        teamLimitation={teamLimitation}
        stale={stale}
        error={error}
        loadingEmpty={loadingEmpty}
        errorEmpty={errorEmpty}
        emptyLabel={inboxEmptyLabel(orderedKeys)}
        hasRows={rowKeys.length > 0}
        hasNextPage={hasNextPage}
        status={status}
        onRefresh={refresh}
        onLoadMore={loadNextPage}
      >
        <PullRequestInboxList
          viewportRef={viewportRef}
          selectedKey={selectedKey}
          mountedRowKeys={mountedRowKeys}
          onKeyDown={handleKeyDown}
          shouldVirtualize={shouldVirtualize}
          virtualizer={virtualizer}
          visibleItems={visibleItems}
          listItems={listItems}
          renderListItem={renderListItem}
        />
      </PullRequestInboxPanel>
    </div>
  );
}
