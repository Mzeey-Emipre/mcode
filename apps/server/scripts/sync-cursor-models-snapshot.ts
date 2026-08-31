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
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { parseCursorCliModelsOutput } from "../../../packages/providers/src/private/cursor/models/cursor-cli-models.js";

const repoRoot = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const inputPath = process.argv[2] ?? NodePath.join(repoRoot, ".mcode-local/cursor-models-stdout.txt");
const stdout = NodeFS.readFileSync(inputPath, "utf8");
const models = parseCursorCliModelsOutput(stdout);

if (models.length === 0) {
  console.error("No models parsed. Run `agent models` and save stdout first.");
  process.exit(1);
}

const outPath = NodePath.join(
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

NodeFS.writeFileSync(outPath, generated, "utf8");
console.log(`Wrote ${models.length} models to ${outPath}`);
