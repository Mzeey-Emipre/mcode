import * as NodeFSPromises from "node:fs/promises";
import type { SkillInfo } from "@mcode/contracts";

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const MAX_PROMPT_TEMPLATE_BYTES = 256 * 1024;
const MAX_PROMPT_TEMPLATE_CACHE_ENTRIES = 64;

/** Parsed slash-command name and raw argument string for Codex command resolution. */
export interface CodexSlashInvocation {
  requestedName: string;
  args: string;
}

/** Error shown when a listed Codex prompt can no longer be expanded safely. */
export class CodexPromptResolutionError extends Error {
  constructor(
    readonly promptName: string,
    cause: unknown,
  ) {
    super(`Could not load Codex prompt /${promptName}. Refresh commands and try again.`);
    this.name = "CodexPromptResolutionError";
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

interface ParsedPromptArguments {
  raw: string;
  positional: string[];
  named: Map<string, string>;
}

interface CachedPromptTemplate {
  size: number;
  mtimeMs: number;
  template: string;
}

const promptTemplateCache = new Map<string, CachedPromptTemplate>();

/** Returns true only for catalog items produced by the Codex custom-prompt adapter. */
export function isCodexCustomPromptCatalogItem(
  item: SkillInfo,
): item is SkillInfo & { path: string } {
  return (
    item.kind === "command"
    && item.source === "user"
    && item.providers.includes("codex")
    && Boolean(item.path)
    && Boolean(item.nativeName)
    && item.name === `prompts:${item.nativeName}`
  );
}

function stripFrontmatter(content: string): string {
  return content.replace(FRONTMATTER_RE, "");
}

function tokenizePromptArguments(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < raw.length; index += 1) {
    const escaped = escapedPromptCharacter(raw, index);
    if (escaped) {
      current += escaped.value;
      index = escaped.nextIndex;
      continue;
    }
    const character = raw[index]!;
    const transition = promptQuoteTransition(quote, character);
    quote = transition.quote;
    if (transition.handled) {
      continue;
    }
    if (quote === null && /\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (current) tokens.push(current);
  return tokens;
}

function escapedPromptCharacter(raw: string, index: number): { value: string; nextIndex: number } | undefined {
  if (raw[index] !== "\\" || index + 1 >= raw.length) return undefined;
  return { value: raw[index + 1]!, nextIndex: index + 1 };
}

function promptQuoteTransition(
  quote: "'" | "\"" | null,
  character: string,
): { quote: "'" | "\"" | null; handled: boolean } {
  if (character !== "'" && character !== "\"") return { quote, handled: false };
  if (quote === null) return { quote: character, handled: true };
  if (quote === character) return { quote: null, handled: true };
  return { quote, handled: false };
}

function parsePromptArguments(raw: string): ParsedPromptArguments {
  const trimmed = raw.trim();
  const positional: string[] = [];
  const named = new Map<string, string>();

  for (const token of tokenizePromptArguments(trimmed)) {
    const namedMatch = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(token);
    if (namedMatch) {
      named.set(namedMatch[1], namedMatch[2]);
      continue;
    }
    positional.push(token);
  }

  return { raw: trimmed, positional, named };
}

async function readCodexPromptTemplate(path: string): Promise<string> {
  const templateStats = await NodeFSPromises.stat(path);
  if (templateStats.size > MAX_PROMPT_TEMPLATE_BYTES) {
    throw new Error(`Codex prompt template is too large: ${path}`);
  }

  const cached = promptTemplateCache.get(path);
  if (
    cached &&
    cached.size === templateStats.size &&
    cached.mtimeMs === templateStats.mtimeMs
  ) {
    promptTemplateCache.delete(path);
    promptTemplateCache.set(path, cached);
    return cached.template;
  }

  const template = stripFrontmatter(await NodeFSPromises.readFile(path, "utf8"));
  promptTemplateCache.set(path, {
    size: templateStats.size,
    mtimeMs: templateStats.mtimeMs,
    template,
  });
  while (promptTemplateCache.size > MAX_PROMPT_TEMPLATE_CACHE_ENTRIES) {
    const oldestKey = promptTemplateCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    promptTemplateCache.delete(oldestKey);
  }
  return template;
}

/** Parses a Codex slash invocation without resolving it against a catalog. */
export function parseCodexSlashInvocation(message: string): CodexSlashInvocation | null {
  const withoutLeadingSpace = message.trimStart();
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(withoutLeadingSpace);
  if (!match) return null;
  return {
    requestedName: match[1],
    args: match[2] ?? "",
  };
}

/**
 * Returns true when a catalog entry is the selected Codex custom prompt.
 */
export function isCodexPromptCommand(
  item: SkillInfo,
  requestedName: string,
): item is SkillInfo & { path: string } {
  return (
    isCodexCustomPromptCatalogItem(item) &&
    item.name === requestedName
  );
}

/**
 * Expands a Codex custom-prompt template with the same placeholder forms
 * documented for `~/.codex/prompts`.
 */
export function expandCodexPromptTemplate(template: string, rawArgs: string): string {
  const args = parsePromptArguments(rawArgs);
  const dollarSentinel = "\0CODEX_LITERAL_DOLLAR\0";
  return template
    .replace(/\$\$/g, dollarSentinel)
    .replace(/\$(ARGUMENTS|[1-9]|[A-Z][A-Z0-9_]*)\b/g, (_match, key: string) => {
      if (key === "ARGUMENTS") return args.raw;
      if (/^[1-9]$/.test(key)) return args.positional[Number(key) - 1] ?? "";
      return args.named.get(key) ?? "";
    })
    .replaceAll(dollarSentinel, "$");
}

/** Expands a discovered Codex prompt command from its cached template file. */
export async function expandCodexPromptCommand(
  command: SkillInfo & { path: string },
  rawArgs: string,
): Promise<string> {
  try {
    const template = await readCodexPromptTemplate(command.path);
    return expandCodexPromptTemplate(template, rawArgs);
  } catch (err) {
    throw new CodexPromptResolutionError(command.name, err);
  }
}

/**
 * Expands a selected Codex prompt slash invocation, or returns null when the
 * message is not a known prompt command.
 */
export async function resolveCodexPromptInvocation(
  message: string,
  catalog: readonly SkillInfo[],
): Promise<string | null> {
  const invocation = parseCodexSlashInvocation(message);
  if (!invocation) return null;

  const command = catalog.find((item) => isCodexPromptCommand(item, invocation.requestedName));
  if (!command) return null;
  return expandCodexPromptCommand(command, invocation.args);
}
