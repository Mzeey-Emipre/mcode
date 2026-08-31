import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");

describe("Browser conformance production boundary", () => {
  it("has no production dependency on app runtimes and imports no adapter code", async () => {
    const packageJson = JSON.parse(await NodeFSPromises.readFile(NodePath.join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      exports?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual(["@mcode/contracts"]);
    expect(packageJson.exports).toEqual({ ".": "./src/index.ts" });
    expect(packageJson.scripts?.build).toBeUndefined();

    const sourceFiles = await NodeFSPromises.readdir(NodePath.join(packageRoot, "src"), { recursive: true });
    for (const file of sourceFiles.filter((value): value is string => value.endsWith(".ts") && !value.includes("__tests__"))) {
      const source = await NodeFSPromises.readFile(NodePath.join(packageRoot, "src", file), "utf8");
      expect(source).not.toMatch(/apps[\\/]?(?:web|server|desktop)/i);
      expect(source).not.toMatch(/Browser(?:SessionDriver|AutomationKernel|AutomationMcpHandler|AutomationBroker)/);
    }

    for (const workspaceRoot of ["apps", "packages"]) {
      const workspaces = await NodeFSPromises.readdir(NodePath.join(packageRoot, "..", "..", workspaceRoot), { withFileTypes: true });
      for (const workspace of workspaces.filter((entry) => entry.isDirectory() && entry.name !== "browser-conformance")) {
        const manifestPath = NodePath.join(packageRoot, "..", "..", workspaceRoot, workspace.name, "package.json");
        try {
          const manifest = JSON.parse(await NodeFSPromises.readFile(manifestPath, "utf8")) as {
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
