/** Collects the three text forms Claude can emit for a one-shot completion. */
export async function collectCompletionText(
  query: AsyncIterable<unknown>,
): Promise<string> {
  let resultText = "";
  let assistantText = "";
  let deltaText = "";
  for await (const message of query) {
    const output = message as Record<string, unknown>;
    if (output.type === "result")
      resultText = readResultText(output, resultText);
    if (output.type === "assistant") assistantText += readAssistantText(output);
    if (output.type === "stream_event") deltaText += readDeltaText(output);
  }
  const text = resultText || assistantText || deltaText;
  if (!text) throw new Error("Claude SDK returned no text content");
  return text.trim();
}

/** Describes provider-owned diagnostics for a side-channel SDK result error. */
export interface ClaudeSideChannelOutputOptions {
  errorPrefix: string;
  emptyMessage: string;
  onResultError?(output: Record<string, unknown>): void;
}

/** Collects assistant text and preserves SDK result errors for side-channel calls. */
export async function collectSideChannelText(
  query: AsyncIterable<unknown>,
  options: ClaudeSideChannelOutputOptions,
): Promise<string> {
  let assistantText = "";
  for await (const message of query) {
    const output = message as Record<string, unknown>;
    if (output.type === "result" && output.is_error) {
      options.onResultError?.(output);
      throw resultError(output, options.errorPrefix);
    }
    if (output.type === "assistant") assistantText += readAssistantText(output);
  }
  if (!assistantText) throw new Error(options.emptyMessage);
  return assistantText.trim();
}

function readResultText(
  output: Record<string, unknown>,
  previous: string,
): string {
  if (output.is_error) throw resultError(output, "Claude SDK");
  return typeof output.result === "string" && output.result
    ? output.result
    : previous;
}

function readAssistantText(output: Record<string, unknown>): string {
  const content =
    (
      output.message as
        { content?: Array<{ type: string; text?: string }> } | undefined
    )?.content ?? [];
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function readDeltaText(output: Record<string, unknown>): string {
  const event = output.event as
    { type?: string; delta?: { type?: string; text?: string } } | undefined;
  return event?.type === "content_block_delta" &&
    event.delta?.type === "text_delta"
    ? (event.delta.text ?? "")
    : "";
}

function resultError(output: Record<string, unknown>, prefix: string): Error {
  const errors = Array.isArray(output.errors)
    ? output.errors.filter((item): item is string => typeof item === "string")
    : [];
  return new Error(`${prefix} error: ${errors.join(", ") || "unknown error"}`);
}
