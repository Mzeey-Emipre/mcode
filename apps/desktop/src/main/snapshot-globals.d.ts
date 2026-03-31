/**
 * Type declarations for the V8 startup snapshot globals.
 *
 * When the LoadBrowserProcessSpecificV8Snapshot fuse is enabled, Electron
 * pre-loads browser_v8_context_snapshot.bin before main.ts runs. The snapshot
 * warmup script (snapshot-entry.ts) stores pre-initialized pure-JS modules
 * on globalThis.__v8Snapshot so the main process can skip re-initialization.
 */

import type { z as ZodZ } from "zod";
import type {
  SettingsSchema as SettingsSchemaType,
  getExtension as GetExtensionType,
} from "@mcode/contracts";

interface V8Snapshot {
  readonly zod: { readonly z: typeof ZodZ };
  readonly contracts: {
    readonly SettingsSchema: typeof SettingsSchemaType;
    readonly getExtension: typeof GetExtensionType;
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __v8Snapshot: V8Snapshot | undefined;
}

export {};
