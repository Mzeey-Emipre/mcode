/** Renderer channel for a Memory Saver discard request on one exact surface. */
export const PREVIEW_SURFACE_DISCARD_REQUESTED_CHANNEL = "preview.surface.discard-requested" as const;

/** Complete identity and generation selected for renderer-side discard. */
export interface PreviewSurfaceDiscardRequest {
  readonly identity: {
    readonly workspaceId: string;
    readonly scope: { readonly kind: "thread" | "workspace"; readonly id: string };
    readonly tabId: string;
  };
  readonly generation: number;
}
