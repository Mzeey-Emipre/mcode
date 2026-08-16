/**
 * Maps Cursor-agent tool payloads to the snake_case shapes Mcode chat renderers expect.
 */

/**
 * Adapts `Edit` and `Write` tool arguments so the web `EditRenderer` / `WriteRenderer`
 * receive `file_path`, `old_string` / `new_string`, or `content` regardless of Cursor field naming.
 *
 * @param toolName - Mcode tool label after discriminator mapping (`Edit`, `Write`, …).
 * @param raw - Raw arguments object from the Cursor ACP envelope.
 */
export function normalizeMcodeCursorToolInput(
  toolName: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== "Edit" && toolName !== "Write") return raw;

  const out: Record<string, unknown> = { ...raw };

  if (toolName === "Edit") {
    copyIfMissing(out, "file_path", pickString(raw, ["file_path", "path", "filePath", "target_file", "filepath"]));
    copyIfMissing(
      out,
      "old_string",
      pickString(raw, ["old_string", "oldString", "search", "oldText", "textToReplace"]),
    );
    copyIfMissing(
      out,
      "new_string",
      pickString(raw, ["new_string", "newString", "replace", "replacement", "replacementText"]),
    );
  }

  if (toolName === "Write") {
    copyIfMissing(out, "file_path", pickString(raw, ["file_path", "path", "filePath", "target_file", "filepath"]));
    if (out.content === undefined || out.content === "") {
      const fromContents =
        typeof raw.contents === "string"
          ? raw.contents
          : pickString(raw, ["content", "text", "body"]);
      if (fromContents !== undefined) out.content = fromContents;
    }
  }

  return out;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function copyIfMissing(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value === undefined || value === "") return;
  const cur = target[key];
  if (cur === undefined || cur === "") target[key] = value;
}
