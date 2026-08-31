import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = NodePath.resolve(import.meta.dirname, "../..");
const SOURCE_ROOT = NodePath.resolve(PACKAGE_ROOT, "src");

function listRuntimeSourceFiles(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return [];
    const path = NodePath.resolve(directory, entry.name);
    if (entry.isDirectory()) return listRuntimeSourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("agent-model runtime boundary", () => {
  it("depends only on the runtime-neutral schema library", () => {
    const packageJson = JSON.parse(NodeFS.readFileSync(NodePath.resolve(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const externalImports = listRuntimeSourceFiles(SOURCE_ROOT).flatMap((path) => {
      const source = NodeFS.readFileSync(path, "utf8");
      return [...source.matchAll(/from\s+["']([^"']+)["']/g)]
        .map((match) => match[1])
        .filter((specifier): specifier is string => Boolean(specifier) && !specifier.startsWith("."));
    });

    expect(Object.keys(packageJson.dependencies ?? {})).toEqual(["zod"]);
    expect([...new Set(externalImports)]).toEqual(["zod"]);
  });
});
