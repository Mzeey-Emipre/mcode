/**
 * V8 snapshot warmup entry point.
 *
 * Executed by electron-mksnapshot at build time to pre-initialize pure-JS
 * modules in the V8 heap. At runtime the main process reads these from
 * globalThis.__v8Snapshot instead of re-initializing from scratch.
 *
 * Constraints (enforced by the V8 snapshot isolate):
 * - No Node.js builtins (fs, path, crypto, net, etc.)
 * - No Electron APIs (app, BrowserWindow, etc.)
 * - Only pure JavaScript that runs in a bare V8 context
 */

import { SettingsSchema, getExtension } from "@mcode/contracts";

const snapshot = Object.freeze({
  contracts: Object.freeze({ SettingsSchema, getExtension }),
});

(globalThis as Record<string, unknown>).__v8Snapshot = snapshot;
