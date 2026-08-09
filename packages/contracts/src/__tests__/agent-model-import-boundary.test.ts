import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CONTRACTS_SOURCE = resolve(import.meta.dirname, "..");
const COMPATIBILITY_MODULE = "compat/agent-model.ts";

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("canonical agent-model import boundary", () => {
  it("keeps the compatibility module as the only direct canonical-model importer", () => {
    const directImporters = listTypeScriptFiles(CONTRACTS_SOURCE)
      .filter((path) => path !== import.meta.filename)
      .filter((path) => readFileSync(path, "utf8").includes('from "@mcode/agent-model"'))
      .map((path) => relative(CONTRACTS_SOURCE, path).replaceAll("\\", "/"));

    expect(directImporters).toEqual([COMPATIBILITY_MODULE]);
  });
});
