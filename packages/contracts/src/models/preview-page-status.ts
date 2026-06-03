import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/**
 * Max lengths for {@link PreviewPageStatus} string fields. Enforced at the IPC
 * boundary so a runaway page title or huge favicon/url cannot blow up renderer
 * state. Mirrors BROWSER_TAB_INFO_STRING_MAX so tab and page-status agree.
 */
export const PREVIEW_PAGE_STATUS_STRING_MAX = {
  url: 4096,
  title: 240,
  favicon: 4096,
  message: 500,
} as const;

/** Load phase of the active preview tab. */
export const PreviewPagePhaseSchema = lazySchema(() =>
  z.enum(["loading", "loaded", "error", "discarded"]),
);
export type PreviewPagePhase = z.infer<ReturnType<typeof PreviewPagePhaseSchema>>;

/**
 * Classified load failure attached to a status whose phase is `error`.
 * Populated by W1 (`classifyLoadResult`); defined here so the reducer and the
 * renderer share one shape.
 */
export const PreviewPageErrorSchema = lazySchema(() =>
  z.object({
    kind: z.enum(["http", "network", "file-not-found", "crash"]),
    status: z.number().int().optional(),
    message: z.string().max(PREVIEW_PAGE_STATUS_STRING_MAX.message),
  }),
);
export type PreviewPageError = z.infer<ReturnType<typeof PreviewPageErrorSchema>>;

/**
 * Full page state for the active preview tab, carried by the single
 * `preview:page-status` channel. The renderer holds exactly one of these and
 * derives loading/title/favicon from it.
 */
export const PreviewPageStatusSchema = lazySchema(() =>
  z.object({
    url: z.string().max(PREVIEW_PAGE_STATUS_STRING_MAX.url).nullable(),
    title: z.string().max(PREVIEW_PAGE_STATUS_STRING_MAX.title).nullable(),
    favicon: z.string().max(PREVIEW_PAGE_STATUS_STRING_MAX.favicon).nullable(),
    phase: PreviewPagePhaseSchema(),
    error: PreviewPageErrorSchema().optional(),
  }),
);
export type PreviewPageStatus = z.infer<ReturnType<typeof PreviewPageStatusSchema>>;
