import { z } from "zod";
import { ProviderCapabilityIdentitySchema } from "../providers/capability-catalog.js";
import { lazySchema } from "../utils/lazySchema.js";

export const MAX_MESSAGE_MENTIONS = 50;
export const MENTION_ID_MAX_LENGTH = 128;
export const MENTION_LABEL_MAX_LENGTH = 512;
export const MENTION_PATH_MAX_LENGTH = 4096;

const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const PATH_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

const MentionRangeSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(1),
}).refine((range) => range.end > range.start, {
  message: "Mention range end must be greater than start",
});

const MentionTextSchema = z.string()
  .min(1)
  .max(MENTION_LABEL_MAX_LENGTH)
  .refine((value) => !CONTROL_CHAR_RE.test(value), {
    message: "Mention text must not contain control characters",
  });

const MentionPathSchema = z.string()
  .min(1)
  .max(MENTION_PATH_MAX_LENGTH)
  .refine((value) => !PATH_CONTROL_CHAR_RE.test(value), {
    message: "Mention path must not contain control characters",
  });

const MentionBaseSchema = z.object({
  id: z.string().min(1).max(MENTION_ID_MAX_LENGTH),
  label: MentionTextSchema,
  range: MentionRangeSchema,
});

/** Typed metadata for a selected composer mention. */
export const MessageMentionSchema = lazySchema(() => z.discriminatedUnion("kind", [
  MentionBaseSchema.extend({
    kind: z.literal("file"),
    path: MentionPathSchema,
  }),
  MentionBaseSchema.extend({
    kind: z.literal("agent"),
    name: MentionTextSchema,
    path: MentionPathSchema,
    provider: z.string().min(1).max(64).optional(),
  }),
  MentionBaseSchema.extend({
    kind: z.literal("plugin"),
    name: MentionTextSchema,
    path: MentionPathSchema.refine((value) => value.startsWith("plugin://"), {
      message: "Plugin mention path must use the plugin:// scheme",
    }),
  }),
  MentionBaseSchema.extend({
    kind: z.literal("command"),
    namespace: z.enum(["skill", "mcode", "plugin", "command"]),
    capabilityIdentity: ProviderCapabilityIdentitySchema().optional(),
  }),
]));

/** Bounded list of typed mention metadata stored on a message. */
export const MessageMentionsSchema = lazySchema(() =>
  z.array(MessageMentionSchema()).max(MAX_MESSAGE_MENTIONS),
);

export type MessageMention = z.infer<ReturnType<typeof MessageMentionSchema>>;
