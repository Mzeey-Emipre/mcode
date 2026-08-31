/**
 * Heuristic labels for Cursor CLI model ids when live catalog and snapshot miss.
 * Mirrors naming from `agent models` (Composer, Codex, Opus 4.7 1M High Thinking, etc.).
 */

const COMPOSER_PATTERN = /^composer-(\d+(?:\.\d+)?)(?:-(.+))?$/;
const NATIVE_CLAUDE_MODEL_PATTERN = /^claude-(opus|sonnet|haiku)-\d+-\d+-\d{6,}/;
const CURSOR_CLI_MODEL_PATTERNS = [
  /^claude-(opus|sonnet|haiku)-\d+-\d+/,
  /^claude-\d+\.\d+-(opus|sonnet|haiku)-/,
  /^claude-\d+-\d+-(opus|sonnet|haiku)-/,
  /^claude-\d+-(opus|sonnet|haiku)/,
  /^(auto|composer-|gpt-|grok-|gemini-|kimi-)/,
] as const;

const TOKEN_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  none: "None",
  fast: "Fast",
  thinking: "Thinking",
  mini: "Mini",
  nano: "Nano",
  codex: "Codex",
  build: "Build",
  pro: "Pro",
  flash: "Flash",
};

/** Title-cases a single hyphenated word. */
function titleCaseWord(word: string): string {
  if (!word) return "";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Maps Claude tail segments; matches `agent models` effort/thinking ordering. */
function formatClaudeTailSegments(tail: string): string[] {
  const thinkingFirst = tail.match(/^thinking-(.+)$/);
  if (thinkingFirst) {
    return [...formatTailSegments(thinkingFirst[1]!), "Thinking"];
  }
  if (tail.endsWith("-thinking")) {
    const effort = tail.slice(0, -"-thinking".length);
    return [...formatTailSegments(effort), "Thinking"];
  }
  const words = formatTailSegments(tail);
  // `-medium` on Claude 4.6 ids denotes 1M context; CLI labels omit the word "Medium".
  if (words.length === 1 && words[0] === "Medium") return [];
  return words;
}

/** Maps tail segments (effort, thinking, fast) to display words. */
function formatTailSegments(tail: string): string[] {
  const parts = tail.split("-").filter(Boolean);
  const words: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "extra" && parts[i + 1] === "high") {
      words.push("Extra High");
      i += 1;
      continue;
    }
    words.push(TOKEN_LABELS[parts[i]!] ?? titleCaseWord(parts[i]!));
  }
  return words;
}

/** Returns true when the id uses Cursor CLI naming (not native Mcode Claude ids). */
export function isCursorCliModelId(modelId: string): boolean {
  if (NATIVE_CLAUDE_MODEL_PATTERN.test(modelId)) return false;
  return CURSOR_CLI_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

function formatAutoCursorModelId(id: string): string | null {
  return id === "auto" ? "Auto" : null;
}

function formatComposerCursorModelId(id: string): string | null {
  const match = id.match(COMPOSER_PATTERN);
  if (!match) return null;
  const [, version, tier] = match;
  return tier ? `Composer ${version} ${titleCaseWord(tier)}` : `Composer ${version}`;
}

function formatClaude46DotModelId(id: string): string | null {
  const match = id.match(/^claude-(\d+)\.(\d+)-(opus|sonnet|haiku)-(.+)$/);
  if (!match) return null;
  const [, major, minor, tier, tail] = match;
  const base = `${titleCaseWord(tier)} ${major}.${minor}`;
  const oneM = id.includes("-medium") ? ["1M"] : [];
  return [base, ...oneM, ...formatClaudeTailSegments(tail)].join(" ");
}

function formatClaude46ModelId(id: string): string | null {
  const match = id.match(/^claude-(\d+)-(\d+)-(opus|sonnet|haiku)-(.+)$/);
  if (!match) return null;
  const [, major, minor, tier, tail] = match;
  const base = `${titleCaseWord(tier)} ${major}.${minor}`;
  const oneM = id.includes("-medium") ? ["1M"] : [];
  return [base, ...oneM, ...formatClaudeTailSegments(tail)].join(" ");
}

function formatClaude47ModelId(id: string): string | null {
  const match = id.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-(.+))?$/);
  if (!match) return null;
  const [, tier, major, minor, tail] = match;
  const base = `${titleCaseWord(tier)} ${major}.${minor}`;
  const oneM = major === "4" && minor === "7" && tier === "opus" ? ["1M"] : [];
  return [base, ...oneM, ...(tail ? formatClaudeTailSegments(tail) : [])].join(" ");
}

function formatClaude4ModelId(id: string): string | null {
  const match = id.match(/^claude-(\d+)-(opus|sonnet|haiku)(?:-(.+))?$/);
  if (!match) return null;
  const [, major, tier, tail] = match;
  const base = `${titleCaseWord(tier)} ${major}`;
  return [base, ...(tail ? formatTailSegments(tail) : [])].join(" ");
}

function formatProviderModelId(
  id: string,
  prefix: "grok-" | "gemini-" | "kimi-",
  label: string,
): string | null {
  if (!id.startsWith(prefix)) return null;
  const tail = id.slice(prefix.length);
  if (prefix === "kimi-") return id.split("-").map(titleCaseWord).join(" ");
  return `${label} ${formatTailSegments(tail).join(" ")}`.trim();
}

const CURSOR_MODEL_FORMATTERS = [
  formatAutoCursorModelId,
  formatComposerCursorModelId,
  formatClaude46DotModelId,
  formatClaude46ModelId,
  formatClaude47ModelId,
  formatClaude4ModelId,
  (id: string) => (id.startsWith("gpt-") ? formatGptCursorModelId(id) : null),
  (id: string) => formatProviderModelId(id, "grok-", "Grok"),
  (id: string) => formatProviderModelId(id, "gemini-", "Gemini"),
  (id: string) => formatProviderModelId(id, "kimi-", "Kimi"),
] as const;

/**
 * Formats a Cursor CLI model id into a display label, or null if the id is not recognized.
 */
export function formatCursorCliModelId(modelId: string): string | null {
  const id = modelId.trim();
  if (!id) return null;
  return CURSOR_MODEL_FORMATTERS
    .map((formatter) => formatter(id))
    .find((label): label is string => label !== null) ?? null;
}

/**
 * Parses Cursor `gpt-*` model ids (GPT, Codex, Mini, Nano, Max variants).
 */
function formatGptCursorModelId(id: string): string {
  const body = id.slice(4);
  const parts = body.split("-").filter(Boolean);
  if (parts.length === 0) return "GPT";

  let version = parts[0] ?? "";
  let idx = 1;
  if (parts[1] && /^\d+$/.test(parts[1])) {
    version = `${parts[0]}.${parts[1]}`;
    idx = 2;
  }

  const rest = parts.slice(idx);
  const isCodex = rest.includes("codex");
  const hasMaxTier = rest.includes("max");
  const oneM =
    rest.includes("medium") && !rest.includes("mini") && !rest.includes("nano") ? ["1M"] : [];

  const prefix = isCodex ? `Codex ${version}` : `GPT-${version}`;
  const tailParts = rest.filter(
    (p) => p !== "codex" && p !== "max" && !(p === "medium" && oneM.length > 0),
  );
  const tail = formatTailSegments(tailParts.join("-"));
  const maxWord = hasMaxTier ? ["Max"] : [];

  return [prefix, ...maxWord, ...oneM, ...tail].filter(Boolean).join(" ");
}
