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
import { execSync, execFileSync } from "child_process";
import { cpSync, existsSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { copyClaudeSdkCliNextTo } from "../../../scripts/build-server-dev-bundle.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const serverRoot = resolve(desktopRoot, "..", "server");
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
    external: ["electron"],
    define: {
      // The main bundle is only used in packaged builds. Setting NODE_ENV
      // at build time ensures getMcodeDir() returns ~/.mcode (not ~/.mcode-dev)
      // even for module-level constants evaluated before app code runs.
      "process.env.NODE_ENV": '"production"',
    },
  }),
  build({
    ...shared,
    entryPoints: ["src/main/preload.ts"],
    outfile: "dist/preload/preload.cjs",
    external: ["electron"],
  }),
]);

console.log("Build complete: dist/main/main.cjs, dist/preload/preload.cjs");

// Step 2: Bundle the server into dist/server/server.cjs
// Phase 2a: tsc compiles TypeScript to ESM JS, preserving emitDecoratorMetadata
// (esbuild does not support emitDecoratorMetadata natively; tsc does it correctly).
// Resolve tsc from the server's local node_modules or fall back to root — the
// `typescript/bin/tsc` JS file works on all platforms without .cmd shims.
const localTsc = resolve(serverRoot, "node_modules/typescript/bin/tsc");
const rootTsc = resolve(serverRoot, "../../node_modules/typescript/bin/tsc");
const tscBin = existsSync(localTsc) ? localTsc : rootTsc;
console.log("Compiling server TypeScript...");
try {
  execFileSync(process.execPath, [tscBin, "--project", resolve(serverRoot, "tsconfig.build.json")], {
    cwd: serverRoot,
    stdio: "inherit",
  });
} catch (err) {
  const tscEntry = resolve(serverRoot, "dist-tsc/index.js");
  if (!existsSync(tscEntry)) {
    throw new Error(`tsc failed and did not emit ${tscEntry}`);
  }
  console.warn("⚠ tsc reported errors but emitted output — continuing with esbuild bundle");
  console.warn("  Fix the type errors above to avoid runtime issues in the packaged app");
}

// Phase 2b: esbuild bundles the tsc output into a single CJS file.
// better-sqlite3 and node-pty are marked external because they contain native
// bindings that cannot be inlined and must be asarUnpack'd by electron-builder.
//
// import.meta.url must resolve to a real file:// URL at runtime because the
// Claude Agent SDK calls fileURLToPath(import.meta.url) to locate its native CLI binary.
// A plain __filename substitution breaks fileURLToPath with ERR_INVALID_URL_SCHEME.
await build({
  ...shared,
  entryPoints: [resolve(serverRoot, "dist-tsc/index.js")],
  outfile: "dist/server/server.cjs",
  external: ["better-sqlite3", "node-pty", "electron", "koffi"],
  banner: {
    js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    "import.meta.url": "__importMetaUrl",
    // Server bundle is only used in packaged builds. Setting NODE_ENV
    // at build time ensures getMcodeDir() returns ~/.mcode.
    "process.env.NODE_ENV": '"production"',
  },
});

console.log("Server bundle complete: dist/server/server.cjs");

const drizzleSrc = resolve(serverRoot, "drizzle");
const drizzleDst = resolve(desktopRoot, "dist/server/drizzle");
if (existsSync(drizzleSrc)) {
  if (existsSync(drizzleDst)) rmSync(drizzleDst, { recursive: true, force: true });
  cpSync(drizzleSrc, drizzleDst, { recursive: true });
  console.log(`Copied Drizzle migrations -> ${drizzleDst}`);
}

// Stage the Claude Agent SDK's native CLI binary under dist/server/node_modules
// so the bundled SDK's createRequire(import.meta.url) resolution finds it.
// dist/server/** is already in asarUnpack, so the binary exists on real disk.
copyClaudeSdkCliNextTo(resolve(desktopRoot, "dist/server/server.cjs"), serverRoot);
console.log("Staged SDK native CLI binary -> dist/server/node_modules");

// Step 3: Build web renderer for Electron (cross-platform env var)
const rendererOutDir = resolve(desktopRoot, "dist", "renderer");

console.log("Building renderer...");
execSync(`npx vite build --outDir ${rendererOutDir}`, {
  cwd: webRoot,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_BUILD: "1" },
});

console.log(`Renderer build complete: ${rendererOutDir}`);
