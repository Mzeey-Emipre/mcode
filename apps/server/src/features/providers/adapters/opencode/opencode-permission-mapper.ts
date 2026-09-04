import type { PermissionDecision, PermissionQuestion, PermissionRequest } from "@mcode/contracts";

/**
 * Upstream reply for `POST /session/{id}/permissions/{permissionID}`.
 * Source: `PostSessionByIdPermissionsByPermissionIdData` in the generated
 * OpenCode SDK (`packages/sdk/js/src/gen/types.gen.ts`).
 */
export type OpenCodePermissionReply = "once" | "always" | "reject";

/** Largest accepted upstream request id (`per_*` / `que_*`); longer is hostile. */
const MAX_REQUEST_ID_CHARS = 128;
/** Largest accepted permission action verb (`bash`, `edit`, ...). */
const MAX_ACTION_CHARS = 128;
/** Largest retained resource pattern per permission request. */
const MAX_RESOURCE_CHARS = 512;
/** Largest retained permission resource list; upstream asks are single-tool. */
const MAX_RESOURCES = 32;
/** Largest retained question title header. */
const MAX_HEADER_CHARS = 200;
/** Largest retained question body. */
const MAX_QUESTION_CHARS = 1_000;
/** Largest retained question option description. */
const MAX_OPTION_DESCRIPTION_CHARS = 500;
/** Largest retained question option label. */
const MAX_OPTION_CHARS = 100;
/** Largest retained question batch; upstream asks stay small. */
const MAX_QUESTIONS = 10;
/** Largest retained option list per question. */
const MAX_OPTIONS = 10;
/** Largest retained card title. */
const MAX_TITLE_CHARS = 200;

function boundString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function acceptedIdentity(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim().length === 0) return undefined;
  return value;
}

function acceptedId(value: unknown): string | undefined {
  return acceptedIdentity(value, MAX_REQUEST_ID_CHARS);
}

function boundStringList(value: unknown, itemMax: number, listMax: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) continue;
    out.push(item.length > itemMax ? item.slice(0, itemMax) : item);
    if (out.length >= listMax) break;
  }
  return out;
}

/**
 * Map an Mcode permission decision onto the upstream permission reply.
 * Mcode owns policy (which card, which decision); the provider only relays.
 * `cancelled` degrades to `reject` because upstream has no cancel variant;
 * the turn still settles through the provider abort path.
 */
export function mapPermissionDecisionToReply(decision: PermissionDecision): OpenCodePermissionReply {
  if (decision === "allow") return "once";
  if (decision === "allow-session") return "always";
  return "reject";
}

/**
 * Build an inline approval card for `permission.v2.asked`
 * (`{ id: per_*, action, resources[] }`) or the legacy `permission.asked`
 * (`{ id, permission }`) shape. Returns null when the envelope carries no
 * usable request identity or action, so the caller can fall back to a bounded
 * diagnostic instead of showing a broken card.
 */
export function synthesizeOpenCodePermissionRequest(input: {
  threadId: string;
  properties: Record<string, unknown>;
}): PermissionRequest | null {
  const requestId = acceptedId(input.properties.id);
  if (requestId === undefined) return null;
  const action = boundString(input.properties.action, MAX_ACTION_CHARS)
    ?? boundString(input.properties.permission, MAX_ACTION_CHARS);
  if (action === undefined) return null;
  const resources = boundStringList(input.properties.resources, MAX_RESOURCE_CHARS, MAX_RESOURCES);
  const title = boundString(input.properties.title, MAX_TITLE_CHARS);
  return {
    requestId,
    threadId: input.threadId,
    toolName: action,
    input: resources.length > 0 ? { action, resources } : { action },
    ...(title === undefined ? {} : { title }),
  };
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionOf(value: unknown): PermissionQuestion["options"][number] | undefined {
  if (!objectRecord(value)) return undefined;
  // Labels are reply identities. Truncating one changes what the user chose,
  // so an oversized label invalidates the card instead of changing it.
  const label = acceptedIdentity(value.label, MAX_OPTION_CHARS);
  if (label === undefined) return undefined;
  const description = boundString(value.description, MAX_OPTION_DESCRIPTION_CHARS);
  return { label, ...(description === undefined ? {} : { description }) };
}

function optionsOf(value: unknown): PermissionQuestion["options"] | undefined {
  if (!Array.isArray(value) || value.length > MAX_OPTIONS) return undefined;
  const options: PermissionQuestion["options"] = [];
  for (const option of value) {
    const mapped = optionOf(option);
    if (mapped === undefined) return undefined;
    options.push(mapped);
  }
  return options;
}

function cardOf(value: unknown): PermissionQuestion | null {
  if (!objectRecord(value)) return null;
  const header = boundString(value.header, MAX_HEADER_CHARS);
  const question = boundString(value.question, MAX_QUESTION_CHARS);
  if (header === undefined || question === undefined) return null;
  const options = optionsOf(value.options);
  if (options === undefined) return null;
  const multiple = value.multiple === true;
  const custom = value.custom === true;
  if (options.length === 0 && !custom) return null;
  return { header, question, options, multiple, custom };
}

/**
 * Build an inline card for `question.v2.asked` / `question.asked`
 * (`{ id: que_*, questions: [{ header, question, options: [{ label }] }] }`).
 * The card reuses the existing permission flow: the user approves or
 * dismisses, and the provider relays that response upstream. Returns the card
 * and preserves the exact selectable labels required by the upstream reply.
 * Returns null when the envelope carries no usable request identity or
 * bounded questions.
 */
export function synthesizeOpenCodeQuestionRequest(input: {
  threadId: string;
  properties: Record<string, unknown>;
}): PermissionRequest | null {
  const requestId = acceptedId(input.properties.id);
  if (requestId === undefined) return null;
  if (!Array.isArray(input.properties.questions)) return null;
  if (input.properties.questions.length === 0 || input.properties.questions.length > MAX_QUESTIONS) return null;
  const questions: PermissionQuestion[] = [];
  for (const item of input.properties.questions) {
    const card = cardOf(item);
    if (!card) return null;
    questions.push(card);
  }
  return {
    requestId,
    threadId: input.threadId,
    toolName: "Question",
    input: {},
    title: questions[0]!.header,
    questions,
  };
}
