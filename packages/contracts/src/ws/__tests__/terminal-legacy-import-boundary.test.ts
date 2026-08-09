import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../../../");
const SOURCE_ROOTS = [
  "apps/server/src",
  "apps/web/src",
  "packages/contracts/src",
] as const;
const ALLOWED_LEGACY_IMPORTERS = new Set([
  "apps/server/src/container.ts",
  "apps/server/src/terminal/terminal-backend-selector.test.ts",
  "apps/server/src/terminal/terminal-backend-selector.ts",
  "apps/web/src/__tests__/TerminalView.focus.test.tsx",
  "apps/web/src/components/terminal/TerminalPoolHost.tsx",
  "apps/web/src/components/terminal/TerminalView.tsx",
  "apps/web/src/terminal/terminal-client-selector.ts",
  "apps/web/src/transport/ws-events.test.ts",
  "apps/web/src/transport/ws-events.ts",
  "apps/web/src/transport/ws-transport.ts",
  "packages/contracts/src/index.ts",
  "packages/contracts/src/ws/__tests__/terminal-legacy-binary.test.ts",
  "packages/contracts/src/ws/channels.ts",
  "packages/contracts/src/ws/methods.ts",
]);

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("Terminal legacy import boundary", () => {
  it("rejects new dependencies on legacy Terminal modules outside approved adapters", () => {
    const unexpectedImporters = SOURCE_ROOTS.flatMap((sourceRoot) =>
      listSourceFiles(resolve(REPOSITORY_ROOT, sourceRoot)),
    )
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return /(?:from\s+|import\()["'][^"']*(?:\/legacy\/|terminal-legacy)/.test(source);
      })
      .map((path) => relative(REPOSITORY_ROOT, path).replaceAll("\\", "/"))
      .filter((path) => !path.includes("/legacy/") && !ALLOWED_LEGACY_IMPORTERS.has(path));

    expect(unexpectedImporters).toEqual([]);
  });
});
