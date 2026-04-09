import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";

/** PR metadata returned by the server. */
export const PrInfoSchema = lazySchema(() =>
  z.object({
    number: z.number(),
    url: z.string(),
    state: z.string(),
  }),
);
/** Basic PR metadata returned by the server. */
export type PrInfo = z.infer<ReturnType<typeof PrInfoSchema>>;

/** Detailed PR metadata for branch picker and URL detection. */
export const PrDetailSchema = lazySchema(() =>
  z.object({
    number: z.number(),
    title: z.string(),
    branch: z.string(),
    author: z.string(),
    url: z.string(),
    state: z.string(),
  }),
);
/** Detailed PR metadata for branch picker and URL detection. */
export type PrDetail = z.infer<ReturnType<typeof PrDetailSchema>>;

/** Parameters for AI-generated PR draft. */
export const PrDraftSchema = lazySchema(() =>
  z.object({
    title: z.string(),
    body: z.string(),
  }),
);

export type PrDraft = z.infer<ReturnType<typeof PrDraftSchema>>;

/** Parameters for creating a PR via the server. */
export const CreatePrParamsSchema = lazySchema(() =>
  z.object({
    workspaceId: z.string(),
    threadId: z.string(),
    title: z.string(),
    body: z.string(),
    baseBranch: z.string(),
    isDraft: z.boolean().default(false),
  }),
);

export type CreatePrParams = z.infer<ReturnType<typeof CreatePrParamsSchema>>;

/** Result returned after PR creation. */
export const CreatePrResultSchema = lazySchema(() =>
  z.object({
    number: z.number(),
    url: z.string(),
  }),
);

export type CreatePrResult = z.infer<ReturnType<typeof CreatePrResultSchema>>;
