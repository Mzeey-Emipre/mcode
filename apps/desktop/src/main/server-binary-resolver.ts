import path from "node:path";
import { existsSync } from "node:fs";

/** Inputs that determine which binary the server child should use. */
export interface ResolveServerBinaryInput {
  /** Electron's `app.isPackaged` — false in dev. */
  isPackaged: boolean;
  /** `process.execPath` — used as the dev-mode and fallback binary. */
  execPath: string;
  /** `process.resourcesPath` — only meaningful when packaged. */
  resourcesPath: string;
  /** `process.platform` — controls extension and image-name expectations. */
  platform: NodeJS.Platform;
  /** Use the main Electron binary when an unsigned packaged test cannot run the renamed copy. */
  preferMainBinary?: boolean;
}

/** Filename of the renamed binary; `.exe` on Windows. */
function renamedBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "mcode-server.exe" : "mcode-server";
}

/**
 * Resolve which executable the server child process should be spawned with.
 *
 * In dev mode the renamed binary doesn't exist — return `execPath` (Electron),
 * which spawn() will run in node mode via `ELECTRON_RUN_AS_NODE=1`.
 *
 * In packaged mode return the renamed copy at `resourcesPath/bin/mcode-server[.exe]`
 * if present. The afterPack build step is responsible for putting it there;
 * if it's missing for any reason fall back to `execPath` so the app still works.
 */
export function resolveServerBinary(input: ResolveServerBinaryInput): string {
  if (
    !input.isPackaged ||
    (input.platform === "darwin" && input.preferMainBinary)
  ) {
    return input.execPath;
  }

  const renamed = path.join(input.resourcesPath, "bin", renamedBinaryName(input.platform));
  if (existsSync(renamed)) return renamed;

  return input.execPath;
}
