/** A user-visible message supplied by the recap.generate caller. */
export interface ThreadRecapMessage {
  role: "user" | "assistant";
  content: string;
}

/** Maximum prompt material characters accepted before recap prompt assembly. */
export const THREAD_RECAP_MAX_MATERIAL_CHARS = 16_000;

const THREAD_RECAP_TARGET_CHARS = 220;
const THREAD_RECAP_MAX_OUTPUT_CHARS = 1_000;

function escapePromptXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Builds the XML-tagged prompt for one-line thread recap generation.
 */
export function buildThreadRecapPrompt(
  messages: ThreadRecapMessage[],
  previousRecap: string | null,
): string {
  const previous = previousRecap?.trim()
    ? escapePromptXmlText(previousRecap.trim())
    : "No previous recap.";
  const transcript = messages
    .map((message, index) =>
      `<message index="${index + 1}" role="${message.role}">\n${escapePromptXmlText(message.content)}\n</message>`,
    )
    .join("\n\n");

  return `<role>
You write a short recap of what the user is working on in this conversation.
</role>

<rules>
- Use only the previous recap and messages below
- Summarize current conversational intent, not code diffs
- Prefer concrete nouns and verbs from the conversation
- Return one to three plain sentences
- No markdown, bullets, quotes, prefixes, or labels
- Aim for under ${THREAD_RECAP_TARGET_CHARS} characters
</rules>

<previous-recap>
${previous}
</previous-recap>

<messages>
${transcript}
</messages>`;
}

/**
 * Normalizes model output to the one-line recap shape expected by clients.
 */
export function sanitizeThreadRecap(text: string): string {
  const oneLine = text
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^(recap|summary)\s*:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

  if (oneLine.length <= THREAD_RECAP_MAX_OUTPUT_CHARS) return oneLine;
  return oneLine.slice(0, THREAD_RECAP_MAX_OUTPUT_CHARS).trimEnd();
}

/**
 * Counts caller-supplied prompt material before generated prompt wrappers are added.
 */
export function threadRecapMaterialLength(
  messages: ThreadRecapMessage[],
  previousRecap: string | null,
): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0)
    + (previousRecap?.length ?? 0);
}
