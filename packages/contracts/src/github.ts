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

/** Individual CI check run (one job in a GitHub Actions workflow). */
export const CheckRunSchema = lazySchema(() =>
  z.object({
    name: z.string(),
    status: z.enum(["queued", "in_progress", "completed"]),
    conclusion: z
      .enum(["success", "failure", "cancelled", "skipped", "timed_out", "neutral"])
      .nullable(),
    durationMs: z.number().nullable(),
  }),
);

/** Individual CI check run. */
export type CheckRun = z.infer<ReturnType<typeof CheckRunSchema>>;

/** Aggregate CI check status for a thread's PR. */
export const ChecksStatusSchema = lazySchema(() =>
  z.object({
    aggregate: z.enum(["passing", "failing", "pending", "no_checks"]),
    runs: z.array(CheckRunSchema()),
    fetchedAt: z.number(),
  }),
);

/** Aggregate CI check status for a thread's PR. */
export type ChecksStatus = z.infer<ReturnType<typeof ChecksStatusSchema>>;
