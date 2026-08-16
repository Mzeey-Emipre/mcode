/**
 * Filesystem browser for the project-selector folder picker.
 * Resolves paths, walks up to the nearest existing ancestor, and returns
 * a capped list of directory entries for display in the UI.
 */

import { injectable } from "tsyringe";
import { stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir, platform } from "node:os";

/** Maximum number of directory entries returned in a single browse response. */
const MAX_ENTRIES = 500;

/** Cache window for the drive list — long enough that fast typing on `/` is free,
 * short enough that newly-mounted drives surface within a couple of keystrokes. */
const DRIVES_CACHE_TTL_MS = 5_000;

let cachedDrives: { name: string; isDir: boolean }[] | null = null;
let cachedDrivesAt = 0;

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
    if (existsSync(root)) {
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
    // Drive enumeration (Windows): bare `/` is a UI affordance to surface drives,
    // since drives have no common parent in the Windows filesystem model.
    if (input === "/" && platform() === "win32") {
      return {
        path: "/",
        parent: null,
        entries: listWindowsDrives(),
        isExactDirectory: false,
      };
    }

    // Expand ~ to home directory, then resolve to an absolute path.
    // Lookahead restricts the match to standalone `~` and `~/...` so inputs
    // like `~foo` are passed through untouched rather than rewritten.
    let target = input.replace(/^~(?=$|[\\/])/, homedir());
    target = resolve(target);

    // Walk up to the nearest existing path (handles ghost paths from stale state).
    let attempts = 0;
    let resolvedToAncestor = false;
    while (target && attempts++ < 50) {
      try {
        await stat(target);
        break;
      } catch {
        resolvedToAncestor = true;
        const parent = dirname(target);
        if (parent === target) break; // reached filesystem root
        target = parent;
      }
    }

    // Final stat can still reject when the ancestor walk lands on a path that
    // disappeared (e.g. an ejected drive root on Windows). Fall back to the
    // drives list on Windows or the root directory on POSIX so the RPC always
    // resolves to a usable browse response.
    let s;
    try {
      s = await stat(target);
    } catch {
      resolvedToAncestor = true;
      if (platform() === "win32") {
        return {
          path: "/",
          parent: null,
          entries: listWindowsDrives(),
          isExactDirectory: false,
        };
      }
      target = "/";
      s = await stat(target);
    }
    // When the resolved target is a file, browse its parent directory.
    const dir = s.isDirectory() ? target : dirname(target);

    const dirents = await readdir(dir, { withFileTypes: true });
    const entries = dirents
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
      .sort((a, b) => {
        // Directories before files; ties broken alphabetically.
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, MAX_ENTRIES);

    const parentDir = dirname(dir);
    return {
      path: dir,
      parent: parentDir === dir ? null : parentDir,
      entries,
      isExactDirectory: !resolvedToAncestor && s.isDirectory(),
    };
  }
}
