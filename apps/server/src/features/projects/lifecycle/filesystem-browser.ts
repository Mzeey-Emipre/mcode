/**
 * Filesystem browser for the project-selector folder picker.
 * Resolves paths, walks up to the nearest existing ancestor, and returns
 * a capped list of directory entries for display in the UI.
 */

import { injectable } from "tsyringe";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

/** Maximum number of directory entries returned in a single browse response. */
const MAX_ENTRIES = 500;

/** Cache window for the drive list — long enough that fast typing on `/` is free,
 * short enough that newly-mounted drives surface within a couple of keystrokes. */
const DRIVES_CACHE_TTL_MS = 5_000;

let cachedDrives: { name: string; isDir: boolean }[] | null = null;
let cachedDrivesAt = 0;

type BrowseTarget = {
  path: string;
  isDirectory: boolean;
  isExactDirectory: boolean;
};

/**
 * Probe `A:\` through `Z:\` synchronously and return the ones that exist.
 * Result is cached for {@link DRIVES_CACHE_TTL_MS} so rapid keystrokes don't
 * fan out into 26 stat calls per character.
 */
function listWindowsDrives(): { name: string; isDir: boolean }[] {
  const now = Date.now();
  if (cachedDrives && now - cachedDrivesAt < DRIVES_CACHE_TTL_MS) {
    return cachedDrives;
  }
  const drives: { name: string; isDir: boolean }[] = [];
  for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    if (NodeFS.existsSync(root)) {
      drives.push({ name: root, isDir: true });
    }
  }
  cachedDrives = drives;
  cachedDrivesAt = now;
  return drives;
}

/** Browses the host filesystem for the project-selector palette's folder picker. */
@injectable()
export class FilesystemBrowser {
  /**
   * List entries at the given path (or its nearest existing ancestor).
   *
   * Special cases:
   * - `~` and `~/...` are expanded to the user's home directory.
   * - `/` on Windows returns the list of available drives.
   * - `/` on POSIX returns the root directory listing.
   *
   * Returns at most 500 entries. Directories sort before files; both groups are sorted alphabetically.
   */
  async browse(input: string): Promise<{
    path: string;
    parent: string | null;
    entries: { name: string; isDir: boolean }[];
    /** Whether the requested path resolved to an existing directory without fallback. */
    isExactDirectory: boolean;
  }> {
    if (isWindowsDrivePicker(input)) return windowsDrivePickerResponse();

    const target = await resolveBrowseTarget(input);
    if (!target) return windowsDrivePickerResponse();
    const dir = target.isDirectory ? target.path : NodePath.dirname(target.path);

    const dirents = await NodeFSPromises.readdir(dir, { withFileTypes: true });
    const entries = dirents
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
      .sort((a, b) => {
        // Directories before files; ties broken alphabetically.
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, MAX_ENTRIES);

    const parentDir = NodePath.dirname(dir);
    return {
      path: dir,
      parent: parentDir === dir ? null : parentDir,
      entries,
      isExactDirectory: target.isExactDirectory,
    };
  }
}

function isWindowsDrivePicker(input: string): boolean {
  return input === "/" && NodeOS.platform() === "win32";
}

function windowsDrivePickerResponse(): {
  path: string;
  parent: null;
  entries: { name: string; isDir: boolean }[];
  isExactDirectory: false;
} {
  return {
    path: "/",
    parent: null,
    entries: listWindowsDrives(),
    isExactDirectory: false,
  };
}

function resolveBrowsePath(input: string): string {
  return NodePath.resolve(input.replace(/^~(?=$|[\\/])/, NodeOS.homedir()));
}

async function resolveBrowseTarget(input: string): Promise<BrowseTarget | null> {
  let path = resolveBrowsePath(input);
  let resolvedToAncestor = false;

  for (let attempts = 0; attempts < 50; attempts += 1) {
    try {
      const details = await NodeFSPromises.stat(path);
      return {
        path,
        isDirectory: details.isDirectory(),
        isExactDirectory: !resolvedToAncestor && details.isDirectory(),
      };
    } catch {
      resolvedToAncestor = true;
      const parent = NodePath.dirname(path);
      if (parent === path) break;
      path = parent;
    }
  }

  return resolveFallbackBrowseTarget();
}

async function resolveFallbackBrowseTarget(): Promise<BrowseTarget | null> {
  if (NodeOS.platform() === "win32") return null;
  const details = await NodeFSPromises.stat("/");
  return { path: "/", isDirectory: details.isDirectory(), isExactDirectory: false };
}
