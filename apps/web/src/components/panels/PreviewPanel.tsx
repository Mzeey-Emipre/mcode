import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Check,
  Globe,
  GripVertical,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type {
  PreviewAnnotationVisualProposal,
  PreviewPageStatus,
} from "@mcode/contracts";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { usePreviewDesignModeStore } from "@/stores/previewDesignModeStore";
import { usePreviewFocusStore } from "@/stores/previewFocusStore";
import { usePreviewTabsStore } from "@/stores/previewTabsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { BrowserHeader } from "./BrowserHeader";
import { PreviewAnnotationHeader } from "./PreviewAnnotationHeader";
import { LocalPortsEmptyState } from "./LocalPortsEmptyState";
import { PreviewErrorPanel } from "./PreviewErrorPanel";
import { PreviewPerfHud } from "./PreviewPerfHud";
import { PreviewWebview, type PreviewWebviewHandle } from "./PreviewWebview";
import { formatNavError, usePreviewBridge } from "./hooks/usePreviewBridge";
import {
  usePreviewCapture,
  type PreviewCaptureKind,
} from "./hooks/usePreviewCapture";
import { usePreviewTabs } from "./hooks/usePreviewTabs";
import {
  normalizePreviewPageIdentity,
  type PreviewDraftAnnotation,
  type SavedPreviewAnnotation,
  usePreviewAnnotationStore,
} from "@/stores/previewAnnotationStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Human-readable label for the capture confirmation badge. */
const CAPTURE_KIND_LABEL: Record<PreviewCaptureKind, string> = {
  viewport: "screenshot",
  region: "region",
  element: "element",
  context: "page context",
};

/** How long the capture confirmation badge stays visible after a successful attach. */
const CAPTURE_CONFIRMATION_DURATION_MS = 2200;
const ANNOTATION_BUBBLE_MAX_WIDTH_PX = 336;
const ANNOTATION_BUBBLE_MARGIN_PX = 8;

const VISUAL_CONTROL_FIELDS = [
  ["textColor", "Text color"],
  ["background", "Background"],
  ["opacity", "Opacity"],
  ["font", "Font"],
  ["fontSize", "Font size"],
  ["fontWeight", "Font weight"],
  ["borderRadius", "Border radius"],
  ["borderColor", "Border color"],
  ["borderWidth", "Border width"],
  ["width", "Width"],
  ["height", "Height"],
  ["padding", "Padding"],
  ["margin", "Margin"],
] as const;

type VisualProposalKey = keyof PreviewAnnotationVisualProposal;
type VisualControlField = (typeof VISUAL_CONTROL_FIELDS)[number][0];

const COLOR_CONTROL_DEFAULTS: Partial<Record<VisualControlField, string>> = {
  textColor: "rgb(10, 52, 92)",
  background: "rgba(0, 0, 0, 0)",
  borderColor: "rgb(10, 52, 92)",
};

const PIXEL_CONTROL_FIELDS = new Set<VisualControlField>([
  "fontSize",
  "borderRadius",
  "borderWidth",
  "width",
  "height",
]);

const EMPTY_SAVED_ANNOTATIONS: SavedPreviewAnnotation[] = [];

function hasVisualProposal(
  value: PreviewAnnotationVisualProposal | undefined,
): boolean {
  if (!value) return false;
  return Object.values(value).some((entry) =>
    typeof entry === "number"
      ? Number.isFinite(entry)
      : Boolean(String(entry ?? "").trim()),
  );
}

function cleanVisualProposal(
  value: PreviewAnnotationVisualProposal,
): PreviewAnnotationVisualProposal | undefined {
  const next: Record<string, string | number> = {};
  for (const [key] of VISUAL_CONTROL_FIELDS) {
    const entry = value[key];
    if (typeof entry === "number") {
      if (Number.isFinite(entry)) next[key] = Math.min(1, Math.max(0, entry));
      continue;
    }
    const trimmed = String(entry ?? "").trim();
    if (trimmed) next[key] = trimmed;
  }
  return Object.keys(next).length > 0
    ? (next as PreviewAnnotationVisualProposal)
    : undefined;
}

function visualOverlayStyle(
  value: PreviewAnnotationVisualProposal | undefined,
): CSSProperties {
  if (!value) return {};
  return {
    color: value.textColor,
    background: value.background,
    opacity: value.opacity,
    fontFamily: value.font,
    fontSize: value.fontSize,
    fontWeight: value.fontWeight,
    borderRadius: value.borderRadius,
    borderColor: value.borderColor,
    borderWidth: value.borderWidth,
    width: value.width,
    height: value.height,
    padding: value.padding,
    margin: value.margin,
    borderStyle: value.borderColor || value.borderWidth ? "solid" : undefined,
  };
}

function visualControlAffordance(
  key: VisualControlField,
): "swatch" | "px" | "0-1" | undefined {
  if (key in COLOR_CONTROL_DEFAULTS) return "swatch";
  if (key === "opacity") return "0-1";
  if (PIXEL_CONTROL_FIELDS.has(key)) return "px";
  return undefined;
}

function colorSwatchValue(
  key: VisualControlField,
  value: unknown,
): string | undefined {
  if (!(key in COLOR_CONTROL_DEFAULTS)) return undefined;
  const candidate = String(value ?? "").trim();
  return candidate || COLOR_CONTROL_DEFAULTS[key];
}

function annotationBubbleStyle(
  bounds: PreviewDraftAnnotation["bounds"],
  surfaceWidth: number,
): CSSProperties {
  const bubbleWidth =
    surfaceWidth > 0
      ? Math.min(
          ANNOTATION_BUBBLE_MAX_WIDTH_PX,
          Math.max(0, surfaceWidth - ANNOTATION_BUBBLE_MARGIN_PX * 2),
        )
      : ANNOTATION_BUBBLE_MAX_WIDTH_PX;
  const preferredLeft = bounds.x + bounds.width + ANNOTATION_BUBBLE_MARGIN_PX;
  const maxLeft =
    surfaceWidth > 0
      ? Math.max(
          ANNOTATION_BUBBLE_MARGIN_PX,
          surfaceWidth - bubbleWidth - ANNOTATION_BUBBLE_MARGIN_PX,
        )
      : preferredLeft;

  return {
    left: Math.min(
      Math.max(ANNOTATION_BUBBLE_MARGIN_PX, preferredLeft),
      maxLeft,
    ),
    top: Math.max(ANNOTATION_BUBBLE_MARGIN_PX, bounds.y),
    maxWidth: `calc(100% - ${ANNOTATION_BUBBLE_MARGIN_PX * 2}px)`,
  };
}

function draftFromSaved(
  threadId: string,
  annotation: SavedPreviewAnnotation,
): PreviewDraftAnnotation {
  return {
    threadId,
    pageIdentity: annotation.pageIdentity,
    bounds: annotation.targetContext.bounds,
    selectorHint: annotation.targetContext.selectorHint,
    label: annotation.targetContext.label,
    snapshot: annotation.snapshot,
    pageContext: annotation.pageContext,
    note: annotation.note ?? "",
    proposedChanges: annotation.proposedChanges,
  };
}

/** Fallback tab id used until the host tab list has loaded. */
export const PREVIEW_WEBVIEW_FALLBACK_TAB_ID =
  "__mcode_webview_active_fallback__";

/** Returns whether the flagged webview renderer should replace the native preview surface. */
export function shouldRenderWebviewPreview(
  engine: string | undefined,
): boolean {
  return engine === "webview";
}

export interface PreviewPanelProps {
  /** Thread that owns preview state (URL memory and future captures). */
  readonly threadId: string;
  /** Active workspace id; scopes spill files under the Mcode app data dir (not the project tree). */
  readonly workspaceId?: string | null;
}

/**
 * Embedded site preview: a clean URL header above a region aligned to an
 * Electron BrowserView. The header morphs across empty / focused / loaded
 * states; when nothing is loaded the surface lists detected localhost ports as
 * one-click cards. Full viewport, drag-selected region, element-pick PNGs, or
 * fence-only page context attach to the composer. A loading banner sits between
 * the header and guest region because the BrowserView stacks above HTML and
 * would hide in-surface overlays. In web-only builds without
 * `desktopBridge.preview`, renders an explanatory empty state.
 */
export function PreviewPanel({ threadId, workspaceId }: PreviewPanelProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const webviewRef = useRef<PreviewWebviewHandle | null>(null);

  const designModeActive = usePreviewDesignModeStore(
    (s) => s.modes[threadId] === true,
  );
  const designModeToggle = usePreviewDesignModeStore((s) => s.toggle);
  const designModeSetActive = usePreviewDesignModeStore((s) => s.setActive);
  const annotationSignal = usePreviewAnnotationStore(
    (s) => s.byThread[threadId]?.length ?? 0,
  );
  const draftAnnotation = usePreviewAnnotationStore((s) => s.drafts[threadId]);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null,
  );
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(
    null,
  );
  const [bubbleNote, setBubbleNote] = useState("");
  const [bubbleVisuals, setBubbleVisuals] =
    useState<PreviewAnnotationVisualProposal>({});
  const [bubbleAdvancedOpen, setBubbleAdvancedOpen] = useState(false);
  const [outsideWarned, setOutsideWarned] = useState(false);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const bubbleNoteInputRef = useRef<HTMLInputElement | null>(null);
  const omniboxFocusTick = usePreviewFocusStore((s) => s.omniboxFocusTick);
  const previewRenderingEngine = useSettingsStore(
    (s) => s.settings.preview.rendering.engine,
  );
  const showWebviewPreview = shouldRenderWebviewPreview(previewRenderingEngine);

  const bridge = usePreviewBridge({
    threadId,
    workspaceId,
    surfaceRef,
    forceHidden: showWebviewPreview,
  });
  const [webviewSrc, setWebviewSrc] = useState<string | null>(null);
  const webviewSrcRef = useRef<string | null>(null);
  const setTrackedWebviewSrc = useCallback((nextSrc: string | null): void => {
    webviewSrcRef.current = nextSrc;
    setWebviewSrc(nextSrc);
  }, []);
  const [webviewNavError, setWebviewNavError] = useState<string | null>(null);
  const [webviewCanBack, setWebviewCanBack] = useState(false);
  const [webviewCanFwd, setWebviewCanFwd] = useState(false);
  const [webviewPageStatus, setWebviewPageStatus] = useState<PreviewPageStatus>(
    {
      url: null,
      title: null,
      favicon: null,
      phase: "loaded",
    },
  );

  // Inline capture confirmation. The composer chip lives in another panel and
  // may scroll off; this badge acknowledges the action where the user is
  // looking. The timer ref lets a second capture reset the dismissal window
  // without leaving a stale badge behind.
  const [lastCapture, setLastCapture] = useState<PreviewCaptureKind | null>(
    null,
  );
  const captureConfirmTimerRef = useRef<number | null>(null);
  const onCaptureSuccess = useCallback((kind: PreviewCaptureKind): void => {
    setLastCapture(kind);
    if (captureConfirmTimerRef.current !== null) {
      window.clearTimeout(captureConfirmTimerRef.current);
    }
    captureConfirmTimerRef.current = window.setTimeout(() => {
      setLastCapture(null);
      captureConfirmTimerRef.current = null;
    }, CAPTURE_CONFIRMATION_DURATION_MS);
  }, []);
  useEffect(() => {
    return () => {
      if (captureConfirmTimerRef.current !== null) {
        window.clearTimeout(captureConfirmTimerRef.current);
      }
    };
  }, []);

  const capture = usePreviewCapture({
    threadId,
    pushSync: bridge.pushSync,
    onSuccess: onCaptureSuccess,
  });
  // Subscribes the scope's tab set into usePreviewTabsStore and exposes the
  // "New page" action for the header. Page switching/closing is driven from the
  // activity rail (the page switcher), so this panel no longer renders a strip.
  const tabs = usePreviewTabs(threadId);
  const activeWebviewTabId =
    tabs.tabSet?.activeTabId ?? PREVIEW_WEBVIEW_FALLBACK_TAB_ID;

  useEffect(() => {
    webviewSrcRef.current = webviewSrc;
  }, [webviewSrc]);

  useEffect(() => {
    if (!showWebviewPreview) return;
    const stored = bridge.storedUrl.trim();
    if (!stored) {
      setTrackedWebviewSrc(null);
      setWebviewPageStatus({
        url: null,
        title: null,
        favicon: null,
        phase: "loaded",
      });
      return;
    }
    if (webviewRef.current?.getUrl() === stored) return;
    if (webviewSrcRef.current === stored) return;
    setTrackedWebviewSrc(stored);
  }, [bridge.storedUrl, setTrackedWebviewSrc, showWebviewPreview, threadId]);

  const onWebviewPageStatus = useCallback(
    (status: PreviewPageStatus): void => {
      setWebviewPageStatus(status);
      if (status.url) {
        useDiffStore.getState().setPreviewUrlForThread(threadId, status.url);
      }
    },
    [threadId],
  );

  const onWebviewNavigate = useCallback(
    (url: string): void => {
      setWebviewNavError(null);
      setWebviewPageStatus((status) => ({ ...status, phase: "loading" }));
      void bridge.resolveNavigation(url).then((result) => {
        if (!result.ok) {
          setWebviewPageStatus((status) => ({ ...status, phase: "loaded" }));
          setWebviewNavError(formatNavError(result.error));
          return;
        }
        useDiffStore.getState().setPreviewUrlForThread(threadId, result.url);
        setWebviewPageStatus({
          url: result.url,
          title: null,
          favicon: null,
          phase: "loading",
        });
        const liveUrl = webviewRef.current?.getUrl();
        const mountedSrc = webviewSrcRef.current;
        if (liveUrl === result.url) {
          webviewRef.current?.reload();
          return;
        }
        if (mountedSrc === result.url) {
          webviewRef.current?.navigate(result.url);
          return;
        }
        setTrackedWebviewSrc(result.url);
      });
    },
    [bridge, setTrackedWebviewSrc, threadId],
  );

  const onWebviewOpenExternal = useCallback((): void => {
    const url = webviewRef.current?.getUrl() || webviewSrc;
    if (url) void window.desktopBridge?.openExternalUrl(url);
  }, [webviewSrc]);

  const onWebviewGetZoom = useCallback(async (): Promise<number> => {
    return (await webviewRef.current?.getZoom()) ?? 1;
  }, []);

  const onWebviewSetZoom = useCallback(
    async (factor: number): Promise<number> => {
      return (await webviewRef.current?.setZoom(factor)) ?? factor;
    },
    [],
  );

  const effectivePageStatus = showWebviewPreview
    ? webviewPageStatus
    : bridge.pageStatus;
  const effectiveInputUrl = showWebviewPreview
    ? (webviewPageStatus.url ?? webviewSrc ?? "")
    : bridge.inputUrl;
  const effectivePageTitle = showWebviewPreview
    ? webviewPageStatus.title
    : bridge.pageTitle;
  const effectiveFaviconUrl = showWebviewPreview
    ? webviewPageStatus.favicon
    : bridge.faviconUrl;
  const effectiveCanBack = showWebviewPreview ? webviewCanBack : bridge.canBack;
  const effectiveCanFwd = showWebviewPreview ? webviewCanFwd : bridge.canFwd;
  const effectivePreviewLoading = showWebviewPreview
    ? webviewPageStatus.phase === "loading"
    : bridge.previewLoading;
  const effectiveNavError = showWebviewPreview
    ? webviewNavError
    : bridge.navError;
  const effectiveNavigate = showWebviewPreview
    ? onWebviewNavigate
    : bridge.onNavigate;
  const effectiveGoBack = showWebviewPreview
    ? () => webviewRef.current?.goBack()
    : bridge.onGoBack;
  const effectiveGoForward = showWebviewPreview
    ? () => webviewRef.current?.goForward()
    : bridge.onGoForward;
  const effectiveReload = showWebviewPreview
    ? () => webviewRef.current?.reload()
    : bridge.onReload;
  const effectiveForceReload = showWebviewPreview
    ? () => webviewRef.current?.forceReload()
    : bridge.onForceReload;
  const effectiveOpenExternal = showWebviewPreview
    ? onWebviewOpenExternal
    : bridge.onOpenExternal;
  const effectiveGetZoom = showWebviewPreview
    ? onWebviewGetZoom
    : bridge.onGetZoom;
  const effectiveSetZoom = showWebviewPreview
    ? onWebviewSetZoom
    : bridge.onSetZoom;
  const currentPageIdentity = normalizePreviewPageIdentity(
    effectivePageStatus.url ?? effectiveInputUrl,
  );
  const savedAnnotations = usePreviewAnnotationStore(
    (s) => s.byThread[threadId] ?? EMPTY_SAVED_ANNOTATIONS,
  );
  const pageAnnotations = useMemo(
    () =>
      savedAnnotations.filter(
        (annotation) => annotation.pageIdentity === currentPageIdentity,
      ),
    [savedAnnotations, currentPageIdentity],
  );
  const bundleCount = annotationSignal;
  const editingSavedAnnotation = editingAnnotationId
    ? pageAnnotations.find(
        (annotation) => annotation.id === editingAnnotationId,
      )
    : undefined;
  const openBubbleBase =
    draftAnnotation ??
    (editingSavedAnnotation
      ? draftFromSaved(threadId, editingSavedAnnotation)
      : undefined);
  const canSaveOpenBubble =
    Boolean(openBubbleBase) &&
    (bubbleNote.trim().length > 0 ||
      hasVisualProposal(cleanVisualProposal(bubbleVisuals)));
  const hasOpenBubble = Boolean(openBubbleBase);
  const openBubbleFocusKey = draftAnnotation
    ? `draft:${draftAnnotation.pageIdentity}:${draftAnnotation.bounds.x}:${draftAnnotation.bounds.y}:${draftAnnotation.bounds.width}:${draftAnnotation.bounds.height}`
    : editingAnnotationId
      ? `edit:${editingAnnotationId}`
      : null;
  const annotationHeaderPageLabel =
    currentPageIdentity || effectiveInputUrl || "current page";

  // Page events flow through `preview:page-status`, not `preview:tabs-updated`
  // (P2), so the host-truth tab set lags the active page's live chrome. Publish
  // it to the store so the rail's page switcher and Browser glyph reflect the
  // active page as it navigates, without re-serializing the whole tab set on
  // every favicon tick. Clear on unmount so a backgrounded scope falls back to
  // each tab's own persisted favicon rather than a stale overlay.
  useEffect(() => {
    usePreviewTabsStore.getState().setLiveChrome(threadId, {
      title: effectivePageStatus.title,
      url: effectivePageStatus.url,
      favicon: effectivePageStatus.favicon,
    });
  }, [threadId, effectivePageStatus]);
  useEffect(() => {
    return () => {
      usePreviewTabsStore.getState().setLiveChrome(threadId, null);
    };
  }, [threadId]);

  useEffect(() => {
    if (!draftAnnotation) return;
    setEditingAnnotationId(null);
    setActiveAnnotationId(null);
    setBubbleNote(draftAnnotation.note);
    setBubbleVisuals(draftAnnotation.proposedChanges ?? {});
    setBubbleAdvancedOpen(false);
    setOutsideWarned(false);
  }, [draftAnnotation]);

  useEffect(() => {
    if (!editingSavedAnnotation) return;
    setBubbleNote(editingSavedAnnotation.note ?? "");
    setBubbleVisuals(editingSavedAnnotation.proposedChanges ?? {});
    setBubbleAdvancedOpen(false);
    setOutsideWarned(false);
  }, [editingSavedAnnotation]);

  useEffect(() => {
    if (!openBubbleFocusKey) return;
    const frame = window.requestAnimationFrame(() => {
      bubbleNoteInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [openBubbleFocusKey]);

  useEffect(() => {
    if (!designModeActive || !hasOpenBubble) return;
    let cancelled = false;
    void window.desktopBridge?.preview?.design
      ?.setAnnotationGuard(true)
      .catch(() => undefined);
    return () => {
      if (cancelled) return;
      cancelled = true;
      void window.desktopBridge?.preview?.design
        ?.setAnnotationGuard(false)
        .catch(() => undefined);
    };
  }, [designModeActive, hasOpenBubble]);

  useEffect(() => {
    if (!openBubbleBase) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && bubbleRef.current?.contains(target)) return;
      if (
        bubbleNote.trim().length === 0 &&
        !hasVisualProposal(cleanVisualProposal(bubbleVisuals))
      ) {
        usePreviewAnnotationStore.getState().setDraft(threadId, undefined);
        setEditingAnnotationId(null);
        setOutsideWarned(false);
        return;
      }
      if (!outsideWarned) {
        setOutsideWarned(true);
        return;
      }
      usePreviewAnnotationStore.getState().setDraft(threadId, undefined);
      setEditingAnnotationId(null);
      setOutsideWarned(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [bubbleNote, bubbleVisuals, openBubbleBase, outsideWarned, threadId]);

  // Design mode is a single state: "next click on the page captures the
  // element under the cursor, repeat until you turn the mode off." Toggling it
  // off cancels any in-flight capture so the picker never sticks.
  const onToggleDesignMode = () => {
    const willActivate = !designModeActive;
    designModeToggle(threadId);
    if (!willActivate) {
      void window.desktopBridge?.preview?.cancelCapture();
    }
  };

  useEffect(() => {
    if (!designModeActive || hasOpenBubble) return;
    let cancelled = false;
    const pickNext = async (): Promise<void> => {
      if (!usePreviewDesignModeStore.getState().isActive(threadId)) return;
      const result = await capture.onAddElementAnnotation();
      if (cancelled) return;
      if (!result.ok) {
        // Cancel / error / Esc-in-guest: exit the mode entirely so the
        // user has a single, consistent way to escape a sticky picker.
        designModeSetActive(threadId, false);
      }
    };
    void pickNext();
    return () => {
      cancelled = true;
    };
  }, [
    designModeActive,
    hasOpenBubble,
    threadId,
    capture.onAddElementAnnotation,
    designModeSetActive,
  ]);

  // Esc must exit design mode no matter where focus is. The global
  // escape.handle binding (default-keybindings.json) closes the current
  // thread on Esc, which would yank the user out of their workspace mid
  // pick session. We attach at capture phase with stopImmediatePropagation
  // so this listener fires before the global keybinding-manager dispatch.
  useEffect(() => {
    if (!designModeActive) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      designModeSetActive(threadId, false);
      void window.desktopBridge?.preview?.cancelCapture();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [designModeActive, designModeSetActive, threadId]);

  if (!window.desktopBridge?.preview) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground"
        data-testid="preview-panel-unavailable"
      >
        <Globe className="size-8 opacity-50" aria-hidden />
        <p className="max-w-xs text-balance">
          Embedded preview runs in the desktop app. Open Mcode from Electron to
          browse http and https sites alongside this thread.
        </p>
      </div>
    );
  }

  const hasLoadedPage = showWebviewPreview
    ? !!(webviewSrc ?? webviewPageStatus.url)
    : bridge.storedUrl.trim().length > 0;
  const pageError =
    effectivePageStatus.phase === "error"
      ? effectivePageStatus.error
      : undefined;
  const showLocalPorts =
    !hasLoadedPage && !effectivePreviewLoading && !pageError;
  const requestComposerSubmit = (): void => {
    window.dispatchEvent(
      new CustomEvent("mcode:submit-composer", {
        detail: { threadId, source: "preview-annotation" },
      }),
    );
  };

  const saveOpenBubble = async (
    options: { readonly sendAfterSave?: boolean } = {},
  ): Promise<void> => {
    if (!openBubbleBase) return;
    const proposedChanges = cleanVisualProposal(bubbleVisuals);
    if (bubbleNote.trim().length === 0 && !proposedChanges) {
      setOutsideWarned(true);
      return;
    }
    const snapshot = await capture.captureAnnotationSnapshot();
    if (!snapshot) return;
    const saved = usePreviewAnnotationStore.getState().saveAnnotation(
      threadId,
      {
        ...openBubbleBase,
        note: bubbleNote,
        proposedChanges,
        snapshot,
      },
      editingAnnotationId ?? undefined,
    );
    setActiveAnnotationId(saved.id);
    setEditingAnnotationId(null);
    setOutsideWarned(false);
    if (options.sendAfterSave) requestComposerSubmit();
  };

  const onBubbleNoteKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    void saveOpenBubble({ sendAfterSave: event.ctrlKey || event.metaKey });
  };

  const deleteOpenBubble = (): void => {
    if (editingAnnotationId) {
      usePreviewAnnotationStore
        .getState()
        .deleteAnnotation(threadId, editingAnnotationId);
    } else {
      usePreviewAnnotationStore.getState().setDraft(threadId, undefined);
    }
    setActiveAnnotationId(null);
    setEditingAnnotationId(null);
    setBubbleAdvancedOpen(false);
    setOutsideWarned(false);
  };

  const activeVisualAnnotation = activeAnnotationId
    ? pageAnnotations.find((annotation) => annotation.id === activeAnnotationId)
    : undefined;
  const openBubbleVisualProposal = openBubbleBase
    ? cleanVisualProposal(bubbleVisuals)
    : undefined;
  const previewSurfaceWidth = surfaceRef.current?.clientWidth ?? 0;

  return (
    <div
      data-testid="preview-panel"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className={cn(showWebviewPreview && "relative z-20")}>
        {designModeActive ? (
          <PreviewAnnotationHeader
            pageCount={pageAnnotations.length}
            bundleCount={bundleCount}
            pageLabel={annotationHeaderPageLabel}
            onDiscardPage={() => {
              usePreviewAnnotationStore
                .getState()
                .discardPage(threadId, currentPageIdentity);
            }}
            onSend={requestComposerSubmit}
            onExit={() => {
              designModeSetActive(threadId, false);
              void window.desktopBridge?.preview?.cancelCapture();
            }}
          />
        ) : (
          <BrowserHeader
            url={effectiveInputUrl}
            pageTitle={effectivePageTitle}
            faviconUrl={effectiveFaviconUrl}
            hasLoadedPage={hasLoadedPage}
            canBack={effectiveCanBack}
            canFwd={effectiveCanFwd}
            threadId={threadId}
            designModeActive={designModeActive}
            elementPickBusy={capture.elementPickBusy}
            captureBusy={capture.captureBusy}
            regionBusy={capture.regionBusy}
            focusRequest={omniboxFocusTick}
            onNavigate={effectiveNavigate}
            onGoBack={effectiveGoBack}
            onGoForward={effectiveGoForward}
            onReload={effectiveReload}
            onOpenExternal={effectiveOpenExternal}
            onToggleDesign={onToggleDesignMode}
            onScreenshot={capture.onAddPictureReference}
            onNewPage={tabs.newTab}
            onForceReload={effectiveForceReload}
            onRegionCapture={capture.onAddRegionPictureReference}
            onDumpContent={capture.onAddPageContextOnly}
            onClearCookies={bridge.onClearCookies}
            onClearCache={bridge.onClearCache}
            onGetZoom={effectiveGetZoom}
            onSetZoom={effectiveSetZoom}
            suppressPreviewForOverlays={!showWebviewPreview}
          />
        )}
      </div>

      {effectiveNavError ? (
        <p
          className="flex-none px-3 py-1 text-xs text-destructive"
          role="status"
        >
          {effectiveNavError}
        </p>
      ) : null}

      {/* Surface aligned to the native BrowserView. When nothing is loaded the
          localhost-ports list owns the surface; once a page loads the native
          guest paints over it. */}
      <div
        ref={surfaceRef}
        role="region"
        aria-label="Page preview"
        data-testid="preview-surface"
        className={cn(
          "relative min-h-[min(40vh,20rem)] min-w-0 flex-1",
          showWebviewPreview
            ? "z-0 overflow-hidden rounded-tl-md"
            : "mx-2 mb-2 mt-1 rounded-md border border-border/40 bg-muted/10",
          showLocalPorts && "overflow-y-auto",
        )}
      >
        {/* Loading: thin indeterminate progress bar at top of content area.
            motion-safe gates the animation so users with prefers-reduced-motion
            get a static bar instead of a perpetual sweep. */}
        {effectivePreviewLoading ? (
          <div
            data-testid="preview-loading-banner"
            className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden rounded-t-md"
            role="status"
            aria-live="polite"
            aria-label="Page loading"
          >
            <div className="h-full w-1/3 motion-safe:animate-preview-loading rounded-full bg-primary/80" />
          </div>
        ) : null}
        {lastCapture ? (
          // Brief acknowledgement of a successful attachment. Sits in the
          // bottom-right so it never overlaps the loading banner at the top
          // and never blocks the page's interactive area. Auto-dismiss after
          // ~2.2s via the host timer.
          <div
            role="status"
            aria-live="polite"
            data-testid="preview-capture-confirmation"
            className={cn(
              "pointer-events-none absolute right-2 bottom-2 z-10 flex items-center gap-1.5",
              // No backdrop-blur: the BrowserView paints opaque underneath
              // anyway, so the blur is a no-op render cost. bg-background/90
              // gives enough contrast over any guest page color.
              "rounded-sm border border-primary/30 bg-background/90 px-2 py-1 shadow-sm",
              "font-mono text-xs uppercase tracking-[0.14em] text-primary",
              "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1",
            )}
          >
            <Check size={11} aria-hidden />
            <span>attached</span>
            <span className="text-primary/60">{"\u00b7"}</span>
            <span>{CAPTURE_KIND_LABEL[lastCapture]}</span>
          </div>
        ) : null}
        {showWebviewPreview ? (
          <div
            data-testid="preview-webview-surface"
            className="absolute inset-0 z-0 overflow-hidden rounded-tl-md"
          >
            {webviewSrc ? (
              <PreviewWebview
                ref={webviewRef}
                threadId={threadId}
                tabId={activeWebviewTabId}
                src={webviewSrc}
                className="relative z-0 h-full w-full"
                onPageStatus={onWebviewPageStatus}
                onNavigationStateChange={(state) => {
                  setWebviewCanBack(state.canGoBack);
                  setWebviewCanFwd(state.canGoForward);
                }}
              />
            ) : null}
          </div>
        ) : null}
        {pageAnnotations.map((annotation) => {
          const targetLabel =
            annotation.targetContext.label?.trim() ||
            annotation.targetContext.selectorHint?.trim() ||
            "Element";
          const note = annotation.note?.trim() || "Visual annotation";
          return (
            <Tooltip key={annotation.id}>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    data-testid="preview-annotation-marker"
                    variant="ghost"
                    size="icon-sm"
                    className="group/marker absolute z-20 flex size-8 items-center justify-center rounded-full bg-transparent p-0 hover:bg-transparent focus-visible:bg-transparent"
                    style={{
                      left: Math.max(
                        16,
                        annotation.targetContext.bounds.x +
                          annotation.targetContext.bounds.width / 2,
                      ),
                      top: Math.max(
                        16,
                        annotation.targetContext.bounds.y +
                          Math.min(annotation.targetContext.bounds.height / 2, 18),
                      ),
                      transform: "translate(-50%, -50%)",
                    }}
                    onClick={() => {
                      setActiveAnnotationId(annotation.id);
                      setEditingAnnotationId(annotation.id);
                    }}
                    aria-label={`Edit annotation ${annotation.displayNumber}`}
                  >
                    <span
                      className="relative flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md ring-2 ring-background/85 transition-transform duration-150 group-hover/marker:scale-105 group-focus-visible/marker:scale-105"
                      aria-hidden
                    >
                      <span className="absolute -bottom-0.5 left-1.5 size-2 rotate-45 rounded-sm bg-primary" />
                      <span className="relative z-10 text-xs font-semibold tabular-nums">
                        {annotation.displayNumber}
                      </span>
                    </span>
                  </Button>
                }
              />
              <TooltipContent
                side="top"
                sideOffset={8}
                className="max-w-72 flex-col items-start gap-1.5 rounded-lg border border-white/10 bg-[#262626] px-3 py-2 text-neutral-100 shadow-xl"
              >
                <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs text-neutral-300">
                  {targetLabel}
                </span>
                <span className="whitespace-pre-wrap text-xs leading-snug">
                  {note}
                </span>
              </TooltipContent>
            </Tooltip>
          );
        })}
        {activeVisualAnnotation?.proposedChanges ? (
          <div
            data-testid="preview-annotation-visual-proposal"
            className="pointer-events-none absolute z-10 rounded-sm border border-dashed border-primary/80"
            style={{
              left: activeVisualAnnotation.targetContext.bounds.x,
              top: activeVisualAnnotation.targetContext.bounds.y,
              minWidth: activeVisualAnnotation.targetContext.bounds.width,
              minHeight: activeVisualAnnotation.targetContext.bounds.height,
              ...visualOverlayStyle(activeVisualAnnotation.proposedChanges),
            }}
          />
        ) : null}
        {openBubbleBase ? (
          <div
            data-testid="preview-annotation-active-target-highlight"
            className="pointer-events-none absolute z-10 rounded-sm border-2 border-primary/80 bg-primary/10"
            style={{
              left: openBubbleBase.bounds.x,
              top: openBubbleBase.bounds.y,
              width: openBubbleBase.bounds.width,
              height: openBubbleBase.bounds.height,
            }}
          />
        ) : null}
        {openBubbleBase && openBubbleVisualProposal ? (
          <div
            data-testid="preview-annotation-visual-proposal"
            className="pointer-events-none absolute z-10 rounded-sm border border-dashed border-primary/80"
            style={{
              left: openBubbleBase.bounds.x,
              top: openBubbleBase.bounds.y,
              minWidth: openBubbleBase.bounds.width,
              minHeight: openBubbleBase.bounds.height,
              ...visualOverlayStyle(openBubbleVisualProposal),
            }}
          />
        ) : null}
        {openBubbleBase ? (
          <div
            ref={bubbleRef}
            data-testid="preview-annotation-bubble"
            className={cn(
              "absolute z-30 w-[min(20.5rem,calc(100%-1rem))] overflow-hidden rounded-[1.65rem] border border-white/10 bg-[#282828] text-neutral-50 shadow-xl",
              bubbleAdvancedOpen ? "max-h-[20.5rem]" : "min-h-11",
              outsideWarned && "animate-pulse border-destructive",
            )}
            style={annotationBubbleStyle(
              openBubbleBase.bounds,
              previewSurfaceWidth,
            )}
          >
            <div className="flex min-h-11 items-center gap-2 px-3 py-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0 rounded-full text-neutral-300 hover:bg-white/10 hover:text-white"
                data-testid="preview-annotation-advanced-toggle"
                aria-label="Open annotation visual controls"
                aria-expanded={bubbleAdvancedOpen}
                onClick={() => setBubbleAdvancedOpen((value) => !value)}
              >
                <SlidersHorizontal size={15} aria-hidden />
              </Button>
              <Input
                ref={bubbleNoteInputRef}
                value={bubbleNote}
                onChange={(event) => {
                  setBubbleNote(event.target.value);
                  setOutsideWarned(false);
                }}
                onKeyDown={onBubbleNoteKeyDown}
                className="h-7 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm text-neutral-50 shadow-none outline-none placeholder:text-neutral-500 focus-visible:ring-0"
                maxLength={4000}
                placeholder="Add a comment..."
                aria-label="Annotation note"
              />
              {canSaveOpenBubble ? (
                <Button
                  type="button"
                  data-testid="preview-annotation-save"
                  size="icon-sm"
                  className="size-8 shrink-0 rounded-full bg-neutral-100 text-neutral-950 hover:bg-white"
                  aria-label="Save annotation"
                  onClick={() => void saveOpenBubble()}
                >
                  <Check size={16} aria-hidden />
                </Button>
              ) : null}
            </div>
            {outsideWarned ? (
              <div className="px-4 pb-2 text-xs text-red-300" role="status">
                Click outside again to discard
              </div>
            ) : null}
            {bubbleAdvancedOpen ? (
              <div
                data-testid="preview-annotation-advanced"
                className="border-t border-white/10 bg-[#282828]"
              >
                <div className="flex items-center justify-between bg-white/[0.06] px-4 py-2 text-xs text-neutral-200">
                  <span className="max-w-[15rem] truncate font-semibold">
                    {openBubbleBase.label?.trim() ||
                      openBubbleBase.selectorHint?.trim() ||
                      "Element"}
                  </span>
                  <GripVertical
                    size={14}
                    className="text-neutral-500"
                    aria-hidden
                  />
                </div>
                <div className="max-h-52 overflow-y-auto px-4 py-2.5 [scrollbar-color:rgb(115_115_115)_transparent] [scrollbar-width:thin]">
                  <div className="space-y-2.5">
                    {VISUAL_CONTROL_FIELDS.map(([key, label]) => {
                      const affordance = visualControlAffordance(key);
                      const value = bubbleVisuals[key as VisualProposalKey];
                      const swatch = colorSwatchValue(key, value);
                      return (
                        <label
                          key={key}
                          className="grid grid-cols-[7.25rem_minmax(0,1fr)] items-center gap-2 text-xs text-neutral-300"
                        >
                          <span>{label}</span>
                          <span className="relative flex min-w-0 items-center">
                            {swatch ? (
                              <span
                                className="pointer-events-none absolute left-2 z-10 size-4 rounded-full border border-white/10"
                                style={{ background: swatch }}
                                aria-hidden
                              />
                            ) : null}
                            <Input
                              size="xs"
                              value={String(value ?? "")}
                              onChange={(event) => {
                                const rawValue = event.target.value;
                                const nextValue =
                                  key === "opacity" && rawValue.trim() !== ""
                                    ? Number(rawValue)
                                    : rawValue;
                                setBubbleVisuals((prev) => ({
                                  ...prev,
                                  [key]: nextValue,
                                }));
                                setOutsideWarned(false);
                              }}
                              placeholder={
                                affordance === "0-1" ? "0-1" : undefined
                              }
                              className={cn(
                                "h-7 rounded-[0.65rem] border-white/10 bg-[#303030] text-neutral-100 placeholder:text-neutral-500 focus-visible:ring-white/20",
                                swatch && "pl-8",
                                affordance === "px" && "pr-8",
                              )}
                            />
                            {affordance === "px" ? (
                              <span className="pointer-events-none absolute right-2 text-xs text-neutral-400">
                                px
                              </span>
                            ) : null}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : null}
            {bubbleAdvancedOpen || editingAnnotationId ? (
              <div className="flex items-center justify-between border-t border-white/10 px-3 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full text-neutral-200 hover:bg-red-500/20 hover:text-red-100"
                  aria-label="Delete annotation"
                  onClick={deleteOpenBubble}
                >
                  <Trash2 size={15} aria-hidden />
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 rounded-full px-3 text-neutral-100 hover:bg-white/10 hover:text-white"
                    onClick={() => {
                      usePreviewAnnotationStore
                        .getState()
                        .setDraft(threadId, undefined);
                      setEditingAnnotationId(null);
                      setBubbleAdvancedOpen(false);
                      setOutsideWarned(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 rounded-full bg-neutral-100 px-3 text-neutral-950 hover:bg-white"
                    disabled={!canSaveOpenBubble}
                    onClick={() => void saveOpenBubble()}
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {pageError ? (
          // Approach A: the native view is hidden (bridge syncs visible:false
          // while phase === "error"), so this HTML panel owns the surface and
          // names the failure with recovery actions.
          <PreviewErrorPanel
            error={pageError}
            url={effectivePageStatus.url}
            canBack={effectiveCanBack}
            onRetry={() => void effectiveReload()}
            onGoBack={() => void effectiveGoBack()}
          />
        ) : null}
        {showLocalPorts ? (
          <LocalPortsEmptyState
            active={showLocalPorts}
            onOpenPort={(port) => effectiveNavigate(`http://localhost:${port}`)}
          />
        ) : null}
      </div>
      <PreviewPerfHud />
    </div>
  );
}
