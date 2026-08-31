/**
 * Build script for the Electron desktop app.
 *
 * 1. Builds main + renderer preload + fixed guest preload with esbuild:
 *    - Main:    src/main/main.ts    -> dist/main/main.cjs
 *    - Preload: src/main/preload.ts -> dist/preload/preload.cjs
 *    - Guest:   src/features/preview/preload/guest-input.ts -> dist/preload/preview-guest-preload.cjs
 * 2. Builds the web renderer with Vite into dist/renderer.
 *
 * Both esbuild targets use CJS output (.cjs) because package.json has "type": "module".
 * The renderer build sets ELECTRON_BUILD=1 programmatically so it works cross-platform.
 */

import { build } from "esbuild";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  buildServerRuntimeBundles,
  compileServerWithSwc,
  copyClaudeSdkCliNextTo,
} from "../../../scripts/build-server-dev-bundle.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopRoot = NodePath.resolve(__dirname, "..");
const serverRoot = NodePath.resolve(desktopRoot, "..", "server");
const webRoot = NodePath.resolve(desktopRoot, "..", "web");

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
  build({
    ...shared,
    entryPoints: ["src/features/preview/preload/guest-input.ts"],
    outfile: "dist/preload/preview-guest-preload.cjs",
    external: ["electron"],
  }),
]);

console.log("Build complete: main, renderer preload, and fixed preview guest preload");

// Step 2: Bundle the server into dist/server/server.cjs
// Phase 2a: swc compiles TypeScript to ESM JS, preserving decorator metadata
// for tsyringe DI (esbuild cannot emit it; swc's `decoratorMetadata` matches
// tsc's `emitDecoratorMetadata`). swc does not typecheck — that is the
// separate `typecheck` verify gate's job — which is what makes this pass
// sub-second instead of ~20s.
console.log("Compiling server TypeScript (swc)...");
compileServerWithSwc(serverRoot);

// Phase 2b: esbuild bundles the tsc output into a single CJS file.
// better-sqlite3 and node-pty are marked external because they contain native
// bindings that cannot be inlined and must be asarUnpack'd by electron-builder.
//
// import.meta.url must resolve to a real file:// URL at runtime because the
// Claude Agent SDK calls fileURLToPath(import.meta.url) to locate its native CLI binary.
// A plain __filename substitution breaks fileURLToPath with ERR_INVALID_URL_SCHEME.
await buildServerRuntimeBundles({
  serverRoot,
  serverOutFile: NodePath.resolve(desktopRoot, "dist/server/server.cjs"),
  ptyHostOutFile: NodePath.resolve(desktopRoot, "dist/server/pty-host.cjs"),
  production: true,
});

console.log("Server bundles complete: dist/server/server.cjs, dist/server/pty-host.cjs");

const drizzleSrc = NodePath.resolve(serverRoot, "drizzle");
const drizzleDst = NodePath.resolve(desktopRoot, "dist/server/drizzle");
if (NodeFS.existsSync(drizzleSrc)) {
  if (NodeFS.existsSync(drizzleDst)) NodeFS.rmSync(drizzleDst, { recursive: true, force: true });
  NodeFS.cpSync(drizzleSrc, drizzleDst, { recursive: true });
  console.log(`Copied Drizzle migrations -> ${drizzleDst}`);
}

// Stage the Claude Agent SDK's native CLI binary under dist/server/node_modules
// for local dev and pre-packaging verification. Packaged installs receive the
// binary via after-pack.mjs because electron-builder excludes nested node_modules.
copyClaudeSdkCliNextTo(NodePath.resolve(desktopRoot, "dist/server/server.cjs"), serverRoot);
console.log("Staged SDK native CLI binary -> dist/server/node_modules");

// Step 3: Build web renderer for Electron (cross-platform env var)
const rendererOutDir = NodePath.resolve(desktopRoot, "dist", "renderer");

console.log("Building renderer...");
NodeChildProcess.execFileSync("bun", ["run", "build", "--", "--outDir", rendererOutDir], {
  cwd: webRoot,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_BUILD: "1" },
});

console.log(`Renderer build complete: ${rendererOutDir}`);
