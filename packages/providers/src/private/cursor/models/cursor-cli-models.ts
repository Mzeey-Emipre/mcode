/**
 * @internal
 * Discovers Cursor Agent models by parsing `cursor-agent models` / `agent models` stdout.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { logger } from "@mcode/shared";
import type { ProviderModelInfo } from "@mcode/contracts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

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
    if (line.startsWith("Tip:")) break;
    const model = parseCursorCliModelLine(line);
    if (model) out.push(model);
  }
  return out;
}

function parseCursorCliModelLine(line: string): ProviderModelInfo | undefined {
  const index = line.indexOf(MODEL_LINE_SEP);
  if (index === -1) return undefined;
  const id = line.slice(0, index).trim();
  const label = line.slice(index + MODEL_LINE_SEP.length).trim();
  if (!id || !label) return undefined;
  const isMaxMode = id.endsWith(MAX_MODE_SUFFIX);
  const name = isMaxMode && !label.includes("(Max)") ? `${label} (Max)` : label;
  return {
    id,
    name,
    group: inferCursorModelGroup(id),
    ...(isMaxMode ? { contextWindow: MAX_MODE_CONTEXT_WINDOW } : {}),
  };
}

/**
 * Runs the Cursor Agent CLI with the `models` subcommand and returns the parsed list,
 * or null if the binary is missing, times out, or output cannot be parsed.
 */
export async function fetchCursorCliModels(
  cliPath: string,
  platform: NodeJS.Platform,
): Promise<ProviderModelInfo[] | null> {
  try {
    const { stdout } = await execFileAsync(cliPath, ["models"], {
      shell: platform === "win32",
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
