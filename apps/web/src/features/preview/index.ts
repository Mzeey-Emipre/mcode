/** Public Preview feature surface for workbench composition. */
export { BrowserAutomationHost } from "@/components/panels/BrowserAutomationHost";
export { BrowserSurfaceHostRoot, browserSurfaceHost } from "./surfaces/BrowserSurfaceHostRoot";
export {
  PREVIEW_WEBVIEW_FALLBACK_TAB_ID,
  WEB_RUNTIME_PREVIEW_TAB_ID,
  PreviewPanel,
} from "./surfaces/PreviewPanel";
export type { PreviewPanelProps } from "./surfaces/PreviewPanel";

export { usePreviewTabSet, usePreviewTabs } from "./tabs/usePreviewTabs";
export {
  previewTabsScopeKey,
  usePreviewDisplayTabSet,
  usePreviewTabsStore,
} from "./state/previewTabsStore";
export type { ClosePageOptions, PreviewLiveChrome } from "./state/previewTabsStore";
export {
  normalizePreviewPageIdentity,
  usePreviewAnnotationStore,
} from "./state/previewAnnotationStore";
export type {
  DiffAnnotationInput,
  PreviewDraftAnnotation,
  SavedDiffAnnotation,
  SavedPreviewAnnotation,
} from "./state/previewAnnotationStore";
export { usePreviewDesignModeStore } from "./state/previewDesignModeStore";
export { usePreviewFocusStore } from "./state/previewFocusStore";
export { usePreviewReferenceQueueStore } from "./state/previewReferenceQueueStore";

export {
  isEmptyPreviewTabUrl,
  isModifierClick,
  isPreviewableUrl,
  openGitHubUrl,
  openUrlInPreview,
} from "./navigation/open-url-in-preview";
export type { OpenUrlInPreviewOptions } from "./navigation/open-url-in-preview";

export { appendBrowserCaptureFence } from "./capture/browser-capture-append";
export {
  appendPreviewAnnotationFence,
  stripPreviewAnnotationFence,
} from "./capture/preview-annotation-append";
export {
  collectSpillPathsFromPendingAttachments,
  releaseBrowserCaptureSpills,
} from "./capture/browser-capture-spill";
