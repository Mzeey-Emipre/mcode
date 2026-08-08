import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Camera,
  PenTool,
  RotateCw,
} from "lucide-react";
import type { BrowserAutomationControllerState } from "@mcode/contracts";
import { cn } from "@/lib/utils";
import { ICON_HIT_SLOP } from "@/lib/ui-hit-target";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useOmniboxState } from "./useOmniboxState";
import { BrowserOverflowMenu } from "./BrowserOverflowMenu";

/** Props for the clean, stateful browser URL header. */
export interface BrowserHeaderProps {
  /** Current URL from the last navigation (drives the omnibox display state). */
  readonly url: string;
  /** Page title once a page is loaded; shown centered in the loaded bar. */
  readonly pageTitle: string | null;
  /** Favicon for the loaded title, when available. */
  readonly faviconUrl: string | null;
  /** True once the guest has a real http(s)/file page loaded. Drives empty vs loaded. */
  readonly hasLoadedPage: boolean;
  readonly canBack: boolean;
  readonly canFwd: boolean;
  /** Thread/workspace scope id; capture + design actions are gated on a real scope. */
  readonly threadId: string;
  /** True while design (element-pick) mode is engaged. */
  readonly designModeActive: boolean;
  /** True while an element-pick session is in flight (shows a spinner on Design). */
  readonly elementPickBusy: boolean;
  /** True while a viewport screenshot is in flight (shows a spinner on Screenshot). */
  readonly captureBusy: boolean;
  /** True while a region crop is in flight (disables Screenshot to avoid overlap). */
  readonly regionBusy: boolean;
  /**
   * Monotonic token: each change focuses + selects the URL input. Lets the
   * mod+shift+b shortcut drop the caret straight into the address bar.
   */
  readonly focusRequest?: number;
  readonly onNavigate: (url: string) => void;
  readonly onGoBack: () => void;
  readonly onGoForward: () => void;
  readonly onReload: () => void;
  readonly onOpenExternal: () => void;
  readonly onToggleDesign: () => void;
  readonly onScreenshot: () => void;
  /** Open a new browser page (kebab). */
  readonly onNewPage: () => void;
  /** Hard reload that bypasses the guest cache (kebab). */
  readonly onForceReload: () => void;
  /** Region crop capture (kebab). */
  readonly onRegionCapture: () => void;
  /** Page-content dump capture (kebab). */
  readonly onDumpContent: () => void;
  /** Clear the preview session's cookies (kebab). */
  readonly onClearCookies: () => void;
  /** Clear the preview session's HTTP cache (kebab). */
  readonly onClearCache: () => void;
  /** Read the guest's current zoom factor (kebab). */
  readonly onGetZoom: () => Promise<number>;
  /** Set the guest's zoom factor (kebab). */
  readonly onSetZoom: (factor: number) => Promise<number>;
  /** Open detached DevTools for the active adopted guest. */
  readonly onOpenDevTools?: () => void;
  /** Toggle the responsive viewport toolbar below this header. */
  readonly onToggleViewportToolbar?: () => void;
  /** Whether the responsive viewport toolbar is visible. */
  readonly viewportToolbarVisible?: boolean;
  /** Current controller for the active visible Browser tab. */
  readonly automationController?: BrowserAutomationControllerState | null;
  /** True while the active tab owns an in-flight browser operation. */
  readonly automationBusy?: boolean;
  /** Transfer the active tab back to human control from the overflow menu. */
  readonly onStopAutomation?: () => void;
  /** Transfer browser control when the human focuses the omnibox. */
  readonly onHumanFocus?: () => void;
}

/**
 * The browser's clean URL header. A minimal back/forward row, a center bar that
 * morphs across three states, and a right cluster of page actions plus the
 * overflow kebab.
 *
 * - **empty** (no page, blurred): the bar reads "Enter a URL" and focuses on click.
 * - **focused**: a ringed pill with an editable URL and the open-in-external arrow.
 * - **loaded** (page, blurred): the page title centered; hovering the bar reveals
 *   reload and open-in-external. Design and Screenshot sit in the right cluster.
 *
 * Navigation, reload, open-in-external, design mode, and screenshot are the
 * existing preview behaviors, repositioned here rather than changed.
 */
export function BrowserHeader({
  url,
  pageTitle,
  faviconUrl,
  hasLoadedPage,
  canBack,
  canFwd,
  threadId,
  designModeActive,
  elementPickBusy,
  captureBusy,
  regionBusy,
  focusRequest,
  onNavigate,
  onGoBack,
  onGoForward,
  onReload,
  onOpenExternal,
  onToggleDesign,
  onScreenshot,
  onNewPage,
  onForceReload,
  onRegionCapture,
  onDumpContent,
  onClearCookies,
  onClearCache,
  onGetZoom,
  onSetZoom,
  onOpenDevTools = () => undefined,
  onToggleViewportToolbar,
  viewportToolbarVisible = false,
  automationController = null,
  automationBusy = false,
  onStopAutomation,
  onHumanFocus,
}: BrowserHeaderProps) {
  const {
    displayValue,
    showFavicon,
    showAsTitle,
    inputRef,
    placeholder,
    onFocus,
    onBlur,
    onChange,
    onSubmit,
  } = useOmniboxState({ url, pageTitle, faviconUrl });

  const [focused, setFocused] = useState(false);
  const [barHover, setBarHover] = useState(false);
  const [faviconError, setFaviconError] = useState(false);

  useEffect(() => setFaviconError(false), [faviconUrl]);

  // Honour focus requests from the parent (mod+shift+b). rAF defers until after
  // layout so the input is mounted and visible when focus + select fire.
  useEffect(() => {
    if (!focusRequest) return;
    const handle = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(handle);
  }, [focusRequest, inputRef]);

  // The loaded title is centered and blurred; hovering it surfaces reload +
  // open-in-external. The focused pill rings and left-aligns the editable URL.
  const showTitle = showAsTitle && !focused;
  const loadedHoverReveal = hasLoadedPage && showTitle && barHover;
  const faviconVisible = showFavicon && !focused && !faviconError;

  return (
    <div
      data-testid="browser-header"
      className="flex h-10 flex-none items-center gap-1 bg-background px-2"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={cn("shrink-0", ICON_HIT_SLOP)}
              disabled={!canBack}
              onClick={onGoBack}
              aria-label="Back"
            >
              <ArrowLeft size={16} aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="top" sideOffset={6} className="text-xs">
          Navigate back
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={cn("shrink-0", ICON_HIT_SLOP)}
              disabled={!canFwd}
              onClick={onGoForward}
              aria-label="Forward"
            >
              <ArrowRight size={16} aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="top" sideOffset={6} className="text-xs">
          Navigate forward
        </TooltipContent>
      </Tooltip>
      {hasLoadedPage ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn("shrink-0", ICON_HIT_SLOP)}
                onClick={onReload}
                aria-label="Reload"
              >
                <RotateCw size={16} aria-hidden />
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="text-xs">
            Reload page
          </TooltipContent>
        </Tooltip>
      ) : null}

      {/* Center bar: morphs across empty / focused / loaded. */}
      <div className="flex min-w-0 flex-1 justify-center px-1">
        <div
          data-testid="browser-url-bar"
          onPointerEnter={() => setBarHover(true)}
          onPointerLeave={() => setBarHover(false)}
          className={cn(
            "flex w-full max-w-xl items-center gap-1.5 rounded-full px-3.5 py-1.5 transition-all",
            focused
              ? "bg-input ring-2 ring-ring/70"
              : loadedHoverReveal
                ? "bg-input ring-1 ring-border"
                : "hover:bg-input/60",
          )}
        >
          {faviconVisible ? (
            <img
              src={faviconUrl!}
              alt=""
              width={14}
              height={14}
              loading="eager"
              className="pointer-events-none size-3.5 shrink-0 rounded-sm"
              onError={() => setFaviconError(true)}
            />
          ) : null}

          <input
            ref={inputRef}
            value={displayValue}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => {
              setFocused(true);
              onHumanFocus?.();
              onFocus();
            }}
            onBlur={() => {
              setFocused(false);
              onBlur();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (e.nativeEvent.isComposing) return;
                e.preventDefault();
                const target = onSubmit();
                if (target.trim()) onNavigate(target);
              }
            }}
            placeholder={placeholder}
            aria-label="Preview URL"
            title={url || undefined}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={cn(
              "min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground",
              showTitle
                ? "cursor-default text-center font-medium text-foreground"
                : "text-foreground",
              !showTitle && !focused && "text-center text-muted-foreground",
              focused && "font-mono",
            )}
          />

          {(focused || loadedHoverReveal) && hasLoadedPage ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onOpenExternal}
                    aria-label="Open in system browser"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <ArrowUpRight size={14} aria-hidden />
                  </button>
                }
              />
              <TooltipContent side="top" sideOffset={6} className="text-xs">
                Open in system browser
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {/* Right cluster: page actions (loaded) plus overflow tools. */}
      {hasLoadedPage ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size={designModeActive ? "sm" : "icon-sm"}
                  aria-label="Design"
                  aria-pressed={designModeActive}
                  disabled={!threadId}
                  onClick={onToggleDesign}
                  className={cn(
                    "shrink-0",
                    ICON_HIT_SLOP,
                    designModeActive && "bg-primary/10 text-primary",
                  )}
                >
                  {elementPickBusy ? (
                    <Spinner size={16} className="text-current" />
                  ) : (
                    <PenTool size={16} aria-hidden />
                  )}
                  {designModeActive ? <span>Design</span> : null}
                </Button>
              }
            />
            <TooltipContent
              side="top"
              sideOffset={6}
              className="max-w-[min(19rem,calc(100vw-1.5rem))] text-xs"
            >
              Design: pick an element to attach to the chat
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Screenshot"
                  disabled={!threadId || captureBusy || regionBusy || elementPickBusy}
                  onClick={onScreenshot}
                  className={cn(
                    "shrink-0",
                    ICON_HIT_SLOP,
                    captureBusy && "bg-primary/10 text-primary",
                  )}
                >
                  {captureBusy ? (
                    <Spinner size={16} className="text-current" />
                  ) : (
                    <Camera size={16} aria-hidden />
                  )}
                </Button>
              }
            />
            <TooltipContent
              side="top"
              sideOffset={6}
              className="max-w-[min(16rem,calc(100vw-1.5rem))] text-xs"
            >
              Screenshot the visible viewport
            </TooltipContent>
          </Tooltip>
        </>
      ) : null}
      <BrowserOverflowMenu
        hasLoadedPage={hasLoadedPage}
        onNewPage={onNewPage}
        onForceReload={onForceReload}
        onDumpContent={onDumpContent}
        onRegionCapture={onRegionCapture}
        onClearCookies={onClearCookies}
        onClearCache={onClearCache}
        onGetZoom={onGetZoom}
        onSetZoom={onSetZoom}
        onOpenDevTools={onOpenDevTools}
        onToggleViewportToolbar={onToggleViewportToolbar}
        viewportToolbarVisible={viewportToolbarVisible}
        automationController={automationController}
        automationBusy={automationBusy}
        onStopAutomation={onStopAutomation}
      />
    </div>
  );
}
