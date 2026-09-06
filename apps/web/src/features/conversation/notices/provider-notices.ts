import type { Message } from "@/transport";

/** Visual urgency used by a Composer provider notice. */
export type ComposerProviderNoticeTone = "attention" | "informative" | "quiet";

/** Provider notice content rendered above the Composer. */
export interface ComposerProviderNotice {
  readonly key: string;
  readonly sessionIdentity: string;
  readonly title: string;
  readonly details: string;
  readonly location?: string;
  readonly tone: ComposerProviderNoticeTone;
}

const COMPOSER_NOTICE_TONES = {
  security: "attention",
  warning: "attention",
  "model-rerouted": "informative",
  configuration: "quiet",
  deprecation: "quiet",
} as const satisfies Partial<Record<NonNullable<Message["systemNotice"]>["kind"], ComposerProviderNoticeTone>>;

const COMPOSER_NOTICE_TITLES = {
  security: "Security warning",
  warning: "Provider warning",
  configuration: "Configuration notice",
  deprecation: "Deprecated setting",
} as const;

function isComposerNoticeKind(
  kind: NonNullable<Message["systemNotice"]>["kind"],
): kind is keyof typeof COMPOSER_NOTICE_TONES {
  return kind in COMPOSER_NOTICE_TONES;
}

function noticeLocation(message: Message): string | undefined {
  const metadata = message.systemNotice;
  if (!metadata?.configPath) return undefined;
  const range = metadata.configRange;
  if (!range) return metadata.configPath;
  return `${metadata.configPath}:${range.startLine}:${range.startColumn}-${range.endLine}:${range.endColumn}`;
}

function noticeSessionIdentity(
  sessionId: string | undefined,
  collectionSessionId: string | null | undefined,
): string {
  const id = sessionId ?? collectionSessionId;
  return id == null ? "unscoped" : `scoped:${id}`;
}

/** Maps persisted provider notices to the compact Composer presentation. */
export function getComposerProviderNotice(
  message: Message,
  collectionSessionId?: string | null,
): ComposerProviderNotice | null {
  if (message.role !== "system" || !message.systemNotice) return null;
  const { kind, noticeKey, sessionId, toModel } = message.systemNotice;
  if (!isComposerNoticeKind(kind)) return null;
  const tone = COMPOSER_NOTICE_TONES[kind];
  const sessionIdentity = noticeSessionIdentity(sessionId, collectionSessionId);
  const notice = {
    key: `${sessionIdentity}:${noticeKey ?? message.id}`,
    sessionIdentity,
    details: message.content,
    location: noticeLocation(message),
  };

  return {
    ...notice,
    title: kind === "model-rerouted"
      ? toModel ? `Model changed to ${toModel}` : "Model changed"
      : COMPOSER_NOTICE_TITLES[kind],
    tone,
  };
}

/** Collects unique notices from the current provider-session collection. */
export function getComposerProviderNotices(
  messages: readonly Message[],
  collectionSessionId?: string | null,
): readonly ComposerProviderNotice[] {
  const seen = new Set<string>();
  return messages.reduce<ComposerProviderNotice[]>((notices, message) => {
    const notice = getComposerProviderNotice(message, collectionSessionId);
    if (!notice || seen.has(notice.key)) return notices;
    seen.add(notice.key);
    notices.push(notice);
    return notices;
  }, []);
}

/** Returns whether a system message is represented by the Composer notice surface. */
export function isComposerProviderNotice(message: Message): boolean {
  return getComposerProviderNotice(message) !== null;
}

/** Returns whether a transcript notice is currently represented by the Composer collection. */
export function isCurrentComposerProviderNotice(
  message: Message,
  currentSessionNotices: readonly Message[],
): boolean {
  if (!isComposerProviderNotice(message)) return false;
  if (message.systemNotice?.scope === "session") return true;
  const noticeKey = message.systemNotice?.noticeKey;
  const sessionId = message.systemNotice?.sessionId ?? null;
  return currentSessionNotices.some((current) => current.id === message.id
    || (noticeKey !== undefined
      && (current.systemNotice?.sessionId ?? null) === sessionId
      && current.systemNotice?.noticeKey === noticeKey));
}
