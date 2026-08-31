import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "../../../../../");
const SOURCE_ROOTS = [
  "apps/server/src",
  "apps/web/src",
  "packages/contracts/src",
] as const;
const ALLOWED_LEGACY_IMPORTERS = new Set([
  "apps/server/src/features/terminal/composition/register-terminal.ts",
  "apps/server/src/features/terminal/backends/__tests__/terminal-backend-selector.test.ts",
  "apps/server/src/features/terminal/backends/terminal-backend-selector.ts",
  "apps/web/src/features/terminal/adapters/__tests__/legacy-terminal-client.test.ts",
  "apps/web/src/features/terminal/adapters/terminal-client-selector.ts",
  "packages/contracts/src/index.ts",
  "packages/contracts/src/ws/__tests__/terminal-legacy-binary.test.ts",
  "packages/contracts/src/ws/channels.ts",
  "packages/contracts/src/ws/methods.ts",
]);

function listLegacyImportCandidates(): string[] {
  try {
    return NodeChildProcess.execFileSync(
      "git",
      [
        "grep",
        "--no-index",
        "-l",
        "-e",
        "/legacy/",
        "-e",
        "terminal-legacy",
        "--",
        ...SOURCE_ROOTS,
      ],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter((path) => /\.(?:ts|tsx)$/.test(path));
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return [];
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Legacy import boundary check requires a working Git checkout${detail}`);
  }
}

describe("Terminal legacy import boundary", () => {
  it("rejects new dependencies on legacy Terminal modules outside approved adapters", () => {
    const unexpectedImporters = listLegacyImportCandidates()
      .filter((path) => {
        const source = NodeFS.readFileSync(NodePath.resolve(REPOSITORY_ROOT, path), "utf8");
        return /(?:from\s+|import\()["'][^"']*(?:\/legacy\/|terminal-legacy)/.test(source);
      })
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => !path.includes("/legacy/") && !ALLOWED_LEGACY_IMPORTERS.has(path));

    expect(unexpectedImporters).toEqual([]);
  });
});
