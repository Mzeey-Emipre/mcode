import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("Browser conformance production boundary", () => {
  it("has no production dependency on app runtimes and imports no adapter code", async () => {
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      exports?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual(["@mcode/contracts"]);
    expect(packageJson.exports).toEqual({ ".": "./src/index.ts" });
    expect(packageJson.scripts?.build).toBeUndefined();

    const sourceFiles = await readdir(join(packageRoot, "src"), { recursive: true });
    for (const file of sourceFiles.filter((value): value is string => value.endsWith(".ts") && !value.includes("__tests__"))) {
      const source = await readFile(join(packageRoot, "src", file), "utf8");
      expect(source).not.toMatch(/apps[\\/]?(?:web|server|desktop)/i);
      expect(source).not.toMatch(/Browser(?:SessionDriver|AutomationKernel|AutomationMcpHandler|AutomationBroker)/);
    }

    for (const workspaceRoot of ["apps", "packages"]) {
      const workspaces = await readdir(join(packageRoot, "..", "..", workspaceRoot), { withFileTypes: true });
      for (const workspace of workspaces.filter((entry) => entry.isDirectory() && entry.name !== "browser-conformance")) {
        const manifestPath = join(packageRoot, "..", "..", workspaceRoot, workspace.name, "package.json");
        try {
          const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
            dependencies?: Record<string, string>;
          };
          expect(manifest.dependencies?.["@mcode/browser-conformance"]).toBeUndefined();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  });
});
