#!/usr/bin/env bun
/**
 * Regenerates {@link CURSOR_CLI_MODEL_SNAPSHOT} from `agent models` / `cursor-agent models`.
 *
 * Usage (repo root):
 *   agent models > .mcode-local/cursor-models-stdout.txt
 *   bun apps/server/scripts/sync-cursor-models-snapshot.ts
 *
 * Or pass a stdout file path:
 *   bun apps/server/scripts/sync-cursor-models-snapshot.ts path/to/models.txt
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCursorCliModelsOutput } from "../../../packages/providers/src/private/cursor/models/cursor-cli-models.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const inputPath = process.argv[2] ?? join(repoRoot, ".mcode-local/cursor-models-stdout.txt");
const stdout = readFileSync(inputPath, "utf8");
const models = parseCursorCliModelsOutput(stdout);

if (models.length === 0) {
  console.error("No models parsed. Run `agent models` and save stdout first.");
  process.exit(1);
}

const outPath = join(
  repoRoot,
  "packages/contracts/src/providers/cursor-cli-models-snapshot.ts",
);

const generated = `import type { ProviderModelInfo } from "./models.js";

/**
 * Snapshot of \`agent models\` output for offline Cursor model labels.
 * Regenerate: \`bun apps/server/scripts/sync-cursor-models-snapshot.ts\`
 *
 * Generated: ${new Date().toISOString().slice(0, 10)} (${models.length} models)
 */
export const CURSOR_CLI_MODEL_SNAPSHOT: readonly ProviderModelInfo[] = ${JSON.stringify(models, null, 2)} as const;
`;

writeFileSync(outPath, generated, "utf8");
console.log(`Wrote ${models.length} models to ${outPath}`);
