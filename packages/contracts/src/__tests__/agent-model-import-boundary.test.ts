import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

const CONTRACTS_SOURCE = NodePath.resolve(import.meta.dirname, "..");
const COMPATIBILITY_MODULE = "compat/agent-model.ts";

function listTypeScriptFiles(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.resolve(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("canonical agent-model import boundary", () => {
  it("keeps the compatibility module as the only direct canonical-model importer", () => {
    const directImporters = listTypeScriptFiles(CONTRACTS_SOURCE)
      .filter((path) => path !== import.meta.filename)
      .filter((path) => NodeFS.readFileSync(path, "utf8").includes('from "@mcode/agent-model"'))
      .map((path) => NodePath.relative(CONTRACTS_SOURCE, path).replaceAll("\\", "/"));

    expect(directImporters).toEqual([COMPATIBILITY_MODULE]);
  });
});
