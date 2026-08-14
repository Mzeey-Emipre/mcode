/** Complete identity and generation for a popup's source Browser surface. */
export interface PreviewPopupSurfaceRef {
  readonly identity: {
    readonly workspaceId: string;
    readonly scope: { readonly kind: "thread" | "workspace"; readonly id: string };
    readonly tabId: string;
  };
  readonly generation: number;
}

/** Renderer channel for typed, opener-free Browser popup requests. */
export const PREVIEW_POPUP_REQUESTED_CHANNEL = "preview.surface.popup-requested" as const;

/** Typed popup request emitted after Electron denies direct popup creation. */
export interface PreviewPopupRequest {
  readonly sourceSurface: PreviewPopupSurfaceRef;
  readonly address: string;
  readonly initiator: "human" | "agent";
}
