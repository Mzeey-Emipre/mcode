import {
  isVirtualBrowserContextAttachment,
  type AttachmentMeta,
  type MessageMention,
  type ProviderCapabilityIdentity,
  type ProviderUsageInfo,
  type QuotaCategory,
  type SkillInfo,
} from "@mcode/contracts";
import {
  expandCodexPromptCommand,
  isCodexPromptCommand,
  parseCodexSlashInvocation,
} from "./codex-prompt.js";
import type {
  CodexRateLimitWindow,
  CodexRateLimitsPayload,
  TurnInputPart,
} from "./codex-types.js";

const MAX_CHILD_THREADS_PER_NOTIFICATION = 128;

/** Maps Codex account-rate-limit payloads into provider usage information. */
export function mapCodexRateLimitsToUsage(payload: unknown): ProviderUsageInfo {
  const rateLimits = readCodexRateLimits(payload);
  const quotaCategories = [
    quotaCategoryFromWindow("Primary limit", rateLimits?.primary ?? null),
    quotaCategoryFromWindow("Secondary limit", rateLimits?.secondary ?? null),
  ].flatMap((category) => category ? [category] : []);
  return { providerId: "codex", quotaCategories };
}

/** Merges sparse Codex account-rate-limit updates into the prior usage snapshot. */
export function mergeCodexUsageInfo(
  current: ProviderUsageInfo,
  next: ProviderUsageInfo,
): ProviderUsageInfo {
  if (next.quotaCategories.length === 0) return current;
  const byLabel = new Map(current.quotaCategories.map((category) => [category.label, category]));
  for (const category of next.quotaCategories) byLabel.set(category.label, category);
  return {
    providerId: "codex",
    quotaCategories: [...byLabel.values()].sort(compareCodexUsageCategories),
  };
}

/** Returns whether a Codex effective configuration contains the internal thread-control MCP server. */
export function hasCodexInternalThreadControlMcp(effectiveConfig: unknown): boolean {
  if (!isRecord(effectiveConfig) || !isRecord(effectiveConfig.config)) return false;
  const mcpServers = effectiveConfig.config.mcp_servers;
  return isRecord(mcpServers) && Object.hasOwn(mcpServers, "mcode_internal_thread_control");
}

/** Builds native Codex input parts from a message, attachments, skills, and mentions. */
export async function buildCodexInput(
  message: string,
  attachments: AttachmentMeta[] | undefined,
  skills: readonly SkillInfo[],
  mentions: readonly MessageMention[],
): Promise<TurnInputPart[]> {
  const inputs = (attachments ?? []).flatMap(mapAttachmentToCodexInput);
  inputs.push(...mentions.flatMap(mapMentionToCodexInput));
  const messageWithAgentUris = rewriteAgentMentionsAsSubagentUris(message, mentions);
  const invocation = await resolveCodexSlashInvocation(messageWithAgentUris, skills, mentions);
  if (invocation.skillItem) inputs.push(invocation.skillItem);
  inputs.push({ type: "text", text: invocation.text });
  return inputs;
}

/** Returns the native child thread id exposed by a sub-agent activity notification. */
export function nativeSubAgentThreadId(notification: { method?: string; params?: Record<string, unknown> }): string | undefined {
  if (!isItemLifecycleNotification(notification.method)) return undefined;
  const item = notification.params?.item;
  if (!isRecord(item) || item.type !== "subAgentActivity" || item.kind !== "started") return undefined;
  return validString(item.agentThreadId);
}

/** Returns distinct child thread ids exposed by a native collab-spawn notification. */
export function nativeCollabSpawnThreadIds(notification: { method?: string; params?: Record<string, unknown> }): string[] {
  if (!isItemLifecycleNotification(notification.method)) return [];
  const item = notification.params?.item;
  if (!isRecord(item) || !isCollabSpawnItem(item)) return [];
  return collectCollabChildThreadIds(item);
}

function quotaCategoryFromWindow(label: string, limit: CodexRateLimitWindow | null): QuotaCategory | undefined {
  const usedPercent = limit?.usedPercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
  const used = Math.max(0, Math.min(100, usedPercent));
  return {
    label: codexRateLimitLabel(limit?.windowDurationMins, label),
    used,
    total: 100,
    remainingPercent: Math.max(0, Math.min(1, (100 - used) / 100)),
    resetDate: codexResetDate(limit?.resetsAt),
    isUnlimited: false,
  };
}

function codexRateLimitLabel(windowDurationMins: number | undefined, fallback: string): string {
  if (windowDurationMins === 300) return "5-hour limit";
  if (windowDurationMins === 10_080) return "Weekly limit";
  return fallback;
}

function compareCodexUsageCategories(a: QuotaCategory, b: QuotaCategory): number {
  return codexUsageCategoryOrder(a) - codexUsageCategoryOrder(b) || a.label.localeCompare(b.label);
}

function codexUsageCategoryOrder(category: QuotaCategory): number {
  if (/^5[- ]hour/i.test(category.label.trim())) return 0;
  if (/^weekly/i.test(category.label.trim())) return 1;
  return 2;
}

function readCodexRateLimits(payload: unknown): CodexRateLimitsPayload["rateLimits"] {
  if (!isRecord(payload) || !isRecord(payload.rateLimits)) return undefined;
  return {
    primary: readCodexRateLimitWindow(payload.rateLimits.primary),
    secondary: readCodexRateLimitWindow(payload.rateLimits.secondary),
  };
}

function readCodexRateLimitWindow(value: unknown): CodexRateLimitWindow | null {
  if (!isRecord(value)) return null;
  return {
    usedPercent: finiteNumber(value.usedPercent),
    windowDurationMins: finiteNumber(value.windowDurationMins),
    resetsAt: finiteNumber(value.resetsAt),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function codexResetDate(resetsAt: number | undefined): string | undefined {
  if (resetsAt === undefined) return undefined;
  const resetDate = new Date(resetsAt * 1000);
  return Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : undefined;
}

function mapAttachmentToCodexInput(attachment: AttachmentMeta): TurnInputPart[] {
  if (isVirtualBrowserContextAttachment(attachment.mimeType)) return [];
  if (attachment.mimeType.startsWith("image/")) return [{ type: "localImage", path: attachment.sourcePath }];
  return [{
    type: "text",
    text: `[Attached file: ${stripControlCharacters(attachment.name)} (${stripControlCharacters(attachment.mimeType)})]`,
  }];
}

function mapMentionToCodexInput(mention: MessageMention): TurnInputPart[] {
  if (mention.kind !== "file" && mention.kind !== "plugin") return [];
  return [{ type: "mention", name: mention.label, path: mention.path }];
}

function stripControlCharacters(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, "");
}

function rewriteAgentMentionsAsSubagentUris(message: string, mentions: readonly MessageMention[]): string {
  let text = message;
  const agentMentions = mentions.filter(isAgentMention).sort((a, b) => b.range.start - a.range.start);
  for (const mention of agentMentions) text = rewriteAgentMention(text, mention);
  return text;
}

function isAgentMention(mention: MessageMention): mention is Extract<MessageMention, { kind: "agent" }> {
  return mention.kind === "agent";
}

function rewriteAgentMention(text: string, mention: Extract<MessageMention, { kind: "agent" }>): string {
  const displayText = `@${mention.label}`;
  if (!mentionRangeMatches(text, mention.range, displayText)) return text;
  return text.slice(0, mention.range.start) + `subagent://${mention.name}` + text.slice(mention.range.end);
}

function mentionRangeMatches(text: string, range: { start: number; end: number }, expected: string): boolean {
  return range.start >= 0 && range.end <= text.length && text.slice(range.start, range.end) === expected;
}

async function resolveCodexSlashInvocation(
  message: string,
  skills: readonly SkillInfo[],
  mentions: readonly MessageMention[],
): Promise<{ text: string; skillItem?: TurnInputPart }> {
  const slash = parseCodexSlashInvocation(message);
  if (!slash) return { text: message };
  const selectedIdentity = selectedCommandIdentity(message, slash.requestedName, mentions);
  const candidates = matchingSkillCandidates(skills, slash.requestedName);
  const selected = selectedIdentity ? candidates.find((item) => matchesCodexCapabilityIdentity(item, selectedIdentity)) : undefined;
  const promptCommand = selectPromptCommand(candidates, selected, selectedIdentity, slash.requestedName);
  if (promptCommand) return { text: await expandCodexPromptCommand(promptCommand, slash.args) };
  const skill = selectSkill(candidates, selected, selectedIdentity);
  return skill ? codexSkillInvocation(skill, slash.args) : { text: message };
}

function selectedCommandIdentity(
  message: string,
  requestedName: string,
  mentions: readonly MessageMention[],
): ProviderCapabilityIdentity | undefined {
  const leadingSpace = message.length - message.trimStart().length;
  const commandEnd = leadingSpace + requestedName.length + 1;
  return mentions.find((mention): mention is Extract<MessageMention, { kind: "command" }> => (
    mention.kind === "command"
    && mention.label === requestedName
    && mention.range.start === leadingSpace
    && mention.range.end === commandEnd
    && mention.capabilityIdentity?.providerId === "codex"
  ))?.capabilityIdentity;
}

function matchingSkillCandidates(skills: readonly SkillInfo[], requestedName: string): SkillInfo[] {
  return skills.filter((item) => item.name === requestedName || item.nativeName === requestedName);
}

function selectPromptCommand(
  candidates: readonly SkillInfo[],
  selected: SkillInfo | undefined,
  identity: ProviderCapabilityIdentity | undefined,
  requestedName: string,
): (SkillInfo & { path: string }) | undefined {
  if (identity?.kind === "customPrompt") return selected && isCodexPromptCommand(selected, requestedName) ? selected : undefined;
  if (identity) return undefined;
  return candidates.find((item) => isCodexPromptCommand(item, requestedName));
}

function selectSkill(
  candidates: readonly SkillInfo[],
  selected: SkillInfo | undefined,
  identity: ProviderCapabilityIdentity | undefined,
): SkillInfo | undefined {
  if (identity?.kind === "skill") return selected?.kind === "skill" ? selected : undefined;
  if (identity) return undefined;
  return candidates.find((item) => item.kind === "skill");
}

function codexSkillInvocation(skill: SkillInfo, args: string): { text: string; skillItem?: TurnInputPart } {
  const nativeName = skill.nativeName ?? skill.name.split(":").pop() ?? skill.name;
  const trimmedArgs = args.trimStart();
  const text = `$${nativeName}${trimmedArgs ? ` ${trimmedArgs}` : ""}`;
  if (!skill.path) return { text };
  return { text, skillItem: { type: "skill", name: nativeName, path: skill.path } };
}

function matchesCodexCapabilityIdentity(item: SkillInfo, identity: ProviderCapabilityIdentity): boolean {
  const matchers = {
    skill: matchesCodexSkillIdentity,
    plugin: matchesCodexCommandIdentity,
    customPrompt: matchesCodexPromptIdentity,
    providerCommand: matchesCodexCommandIdentity,
  };
  return matchers[identity.kind](item, identity.nativeId);
}

function matchesCodexSkillIdentity(item: SkillInfo, nativeId: string): boolean {
  return item.kind === "skill" && (item.path ?? item.nativeName ?? item.name) === nativeId;
}

function matchesCodexPromptIdentity(item: SkillInfo, nativeId: string): boolean {
  return isCodexPromptCommand(item, item.name) && (item.nativeName ?? item.name) === nativeId;
}

function matchesCodexCommandIdentity(item: SkillInfo, nativeId: string): boolean {
  return item.kind === "command" && !isCodexPromptCommand(item, item.name) && (item.nativeName ?? item.name) === nativeId;
}

function isItemLifecycleNotification(method: string | undefined): boolean {
  return method === "item/started" || method === "item/completed";
}

function isCollabSpawnItem(item: Record<string, unknown>): boolean {
  const kind = item.tool ?? item.kind;
  return item.type === "collabAgentToolCall" && (kind === "spawnAgent" || kind === "spawn_agent");
}

function collectCollabChildThreadIds(item: Record<string, unknown>): string[] {
  const childThreadIds = new Set<string>();
  for (const childThreadId of arrayStrings(item.receiverThreadIds)) childThreadIds.add(childThreadId);
  if (isRecord(item.agentsStates)) {
    for (const rawChildThreadId of Object.keys(item.agentsStates)) {
      const childThreadId = validString(rawChildThreadId);
      if (childThreadId) childThreadIds.add(childThreadId);
    }
  }
  return [...childThreadIds].slice(0, MAX_CHILD_THREADS_PER_NOTIFICATION);
}

function arrayStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_CHILD_THREADS_PER_NOTIFICATION).flatMap((entry) => {
    const string = validString(entry);
    return string ? [string] : [];
  });
}

function validString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
