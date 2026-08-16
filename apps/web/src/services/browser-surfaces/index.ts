export {
  BrowserSurfaceHost,
} from "@/features/preview/browser-surfaces/BrowserSurfaceHost";
export type {
  BrowserSurfaceAdapter,
  BrowserSurfaceAdapterEvent,
  BrowserSurfaceAdapterEventBase,
  BrowserSurfaceAdapterEventPayload,
  BrowserSurfaceAdapterFactory,
  BrowserSurfaceCreateOptions,
  BrowserSurfaceDisposalReason,
  BrowserSurfaceDocumentAccess,
  BrowserSurfaceHostOptions,
  BrowserSurfaceIdentity,
  BrowserSurfaceListener,
  BrowserSurfaceMaterializedListener,
  BrowserSurfaceMetadata,
  BrowserSurfaceNavigationState,
  BrowserSurfacePagePhase,
  BrowserSurfacePageState,
  BrowserSurfacePresentation,
  BrowserSurfaceScheduling,
  BrowserSurfaceVisibility,
} from "@/features/preview/browser-surfaces/BrowserSurfaceHost";
export { normalizeBrowserSurfaceAddress } from "@/features/preview/browser-surfaces/browserSurfaceAddress";
export {
  ElectronWebviewBrowserSurfaceAdapter,
  createElectronWebviewBrowserSurfaceAdapterFactory,
  createElectronWebviewSurfaceAdapterFactory,
  normalizeElectronWebviewSurfaceAddress,
} from "@/features/preview/browser-surfaces/ElectronWebviewBrowserSurfaceAdapter";
export type {
  ElectronWebviewBrowserSurfaceAdapterFactoryOptions,
  ElectronWebviewBrowserSurfaceAdapterOptions,
} from "@/features/preview/browser-surfaces/ElectronWebviewBrowserSurfaceAdapter";
export {
  WebIframeBrowserSurfaceAdapter,
  createIframeBrowserSurfaceAdapterFactory,
  createWebIframeBrowserSurfaceAdapterFactory,
  createWebIframeSurfaceAdapterFactory,
} from "@/features/preview/browser-surfaces/WebIframeBrowserSurfaceAdapter";
export type {
  WebIframeBrowserSurfaceAdapterFactoryOptions,
  WebIframeBrowserSurfaceObservation,
} from "@/features/preview/browser-surfaces/WebIframeBrowserSurfaceAdapter";
