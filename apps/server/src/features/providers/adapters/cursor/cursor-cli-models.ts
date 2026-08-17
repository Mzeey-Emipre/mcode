/**
 * Discovers Cursor Agent models by parsing `cursor-agent models` / `agent models` stdout.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "@mcode/shared";
import type { ProviderModelInfo } from "@mcode/contracts";

const execFileAsync = promisify(execFile);

/** Separator between model id and label in `agent models` output lines. */
const MODEL_LINE_SEP = " - ";

/** Context window token count for Max mode (-medium suffix) models. */
const MAX_MODE_CONTEXT_WINDOW = 1_000_000;

/** Suffix Cursor uses for Max mode (1M context) model variants. */
const MAX_MODE_SUFFIX = "-medium";

/**
 * Maps a Cursor CLI model id to a UI vendor group (matches Cursor CLI section headers).
 */
export function inferCursorModelGroup(modelId: string): string {
  if (modelId === "auto" || modelId.startsWith("composer-")) return "Cursor";
  if (modelId.startsWith("claude-")) return "Anthropic";
  if (modelId.startsWith("gpt-")) return "OpenAI";
  if (modelId.startsWith("gemini-")) return "Google";
  if (modelId.startsWith("grok-")) return "xAI";
  if (modelId.startsWith("kimi-")) return "Kimi";
  return "Other";
}

/**
 * Parses stdout from `agent models` into structured rows (skips header and trailing tip).
 */
export function parseCursorCliModelsOutput(stdout: string): ProviderModelInfo[] {
  const lines = stdout.split(/\r?\n/);
  const out: ProviderModelInfo[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === "Available models") continue;
    if (line.startsWith("Tip:")) break;
    const idx = line.indexOf(MODEL_LINE_SEP);
    if (idx === -1) continue;
    const id = line.slice(0, idx).trim();
    let name = line.slice(idx + MODEL_LINE_SEP.length).trim();
    if (!id || !name) continue;

    const isMaxMode = id.endsWith(MAX_MODE_SUFFIX);

    // Cursor's Max mode variants have a 1M-token context window; ensure the
    // display label reflects that so users can distinguish them in the picker.
    if (isMaxMode && !name.includes("(Max)")) {
      name = `${name} (Max)`;
    }

    out.push({
      id,
      name,
      group: inferCursorModelGroup(id),
      ...(isMaxMode && { contextWindow: MAX_MODE_CONTEXT_WINDOW }),
    });
  }
  return out;
}

/**
 * Runs the Cursor Agent CLI with the `models` subcommand and returns the parsed list,
 * or null if the binary is missing, times out, or output cannot be parsed.
 */
export async function fetchCursorCliModels(cliPath: string): Promise<ProviderModelInfo[] | null> {
  try {
    const { stdout } = await execFileAsync(cliPath, ["models"], {
      shell: process.platform === "win32",
      maxBuffer: 12 * 1024 * 1024,
      timeout: 60_000,
    });
    const parsed = parseCursorCliModelsOutput(String(stdout));
    return parsed.length > 0 ? parsed : null;
  } catch (err: unknown) {
    logger.warn("Cursor CLI models discovery failed", {
      cliPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
