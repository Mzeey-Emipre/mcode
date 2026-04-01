/**
 * Build script for the Electron desktop app.
 *
 * 1. Builds main + preload with esbuild:
 *    - Main:    src/main/main.ts    -> dist/main/main.cjs
 *    - Preload: src/main/preload.ts -> dist/preload/preload.cjs
 * 2. Builds the web renderer with Vite into dist/renderer.
 *
 * Both esbuild targets use CJS output (.cjs) because package.json has "type": "module".
 * The renderer build sets ELECTRON_BUILD=1 programmatically so it works cross-platform.
 */

import { build } from "esbuild";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const webRoot = resolve(desktopRoot, "..", "web");

/** Shared esbuild options for both entry points. */
const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  format: "cjs",
};

// Step 1: Build main + preload
await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main/main.cjs",
    external: ["electron", "@mcode/contracts", "@mcode/shared"],
  }),
  build({
    ...shared,
    entryPoints: ["src/main/preload.ts"],
    outfile: "dist/preload/preload.cjs",
    external: ["electron", "@mcode/contracts", "@mcode/shared"],
  }),
]);

console.log("Build complete: dist/main/main.cjs, dist/preload/preload.cjs");

// Step 2: Build web renderer for Electron (cross-platform env var)
const rendererOutDir = resolve(desktopRoot, "dist", "renderer");

console.log("Building renderer...");
execSync(`npx vite build --outDir ${rendererOutDir}`, {
  cwd: webRoot,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_BUILD: "1" },
});

console.log(`Renderer build complete: ${rendererOutDir}`);
