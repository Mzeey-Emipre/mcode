/**
 * Pure palette logic: normalization, ranking, filtering, and item builders.
 * No React or store imports -- fully testable in isolation.
 */

/** A palette item with searchable fields. */
export interface PaletteItem {
  /** Unique value used to identify the item when selected. */
  value: string;
  /** Primary label shown in the palette list. */
  title: string;
  /** Optional secondary label (e.g. file path). */
  description?: string;
  /** Ordered list of strings to match against the query. Earlier entries rank higher. */
  searchTerms: string[];
}

/** A group of palette items with a section heading. */
export interface PaletteGroup {
  /** Heading displayed above the group in the palette. */
  heading: string;
  /** Items belonging to this group. */
  items: PaletteItem[];
}

/**
 * Normalize a search query: trim leading/trailing whitespace, lowercase,
 * and collapse internal runs of whitespace to a single space.
 */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Score how well `field` matches `term`.
 * Returns 3 for exact match, 2 for prefix match, 1 for substring, -Infinity for no match.
 * Comparison is case-insensitive.
 */
export function rankSearchFieldMatch(field: string, term: string): number {
  const f = field.toLowerCase();
  const t = term.toLowerCase();
  if (f === t) return 3;
  if (f.startsWith(t)) return 2;
  if (f.includes(t)) return 1;
  return -Infinity;
}

/**
 * Score a PaletteItem against a single query token.
 * Earlier searchTerms earn an index bonus (1000 - index * 100) so that
 * matches on the primary term outrank matches on secondary terms.
 */
function scoreItemForToken(item: PaletteItem, token: string): number {
  let best = -Infinity;
  for (let i = 0; i < item.searchTerms.length; i++) {
    const fieldRank = rankSearchFieldMatch(item.searchTerms[i], token);
    if (fieldRank > -Infinity) {
      const score = 1000 - i * 100 + fieldRank;
      if (score > best) best = score;
    }
  }
  return best;
}

/**
 * Filter and rank palette groups against a query string.
 * When the query is empty, all groups are returned unchanged.
 * Items that do not match any token are dropped; groups that become empty are dropped.
 * Surviving items within each group are sorted by score descending.
 */
export function filterCommandPaletteGroups(groups: PaletteGroup[], query: string): PaletteGroup[] {
  const q = normalizeQuery(query);
  if (!q) return groups;
  const tokens = q.split(" ");

  return groups
    .map((group) => {
      const scored = group.items
        .map((item) => {
          // An item must match all tokens; any single -Infinity token eliminates it.
          const score = tokens.reduce<number>((acc, token) => {
            const s = scoreItemForToken(item, token);
            return s === -Infinity ? -Infinity : acc + s;
          }, 0);
          return { item, score };
        })
        .filter(({ score }) => score > -Infinity)
        .sort((a, b) => b.score - a.score)
        .map(({ item }) => item);

      return { ...group, items: scored };
    })
    .filter((g) => g.items.length > 0);
}

/**
 * One of five mutually exclusive palette modes derived from the input query.
 * Mode is computed each render — no persistent mode state.
 *
 * - `root`     — empty query; show Actions + Recent Threads + Recent Projects.
 * - `actions`  — query starts with `>`; filter the Actions group only.
 * - `browse`   — query is a path (~/, /foo, ./, ../, C:\…); show filesystem entries.
 * - `drives`   — query is exactly `/`; show available drives (Windows) or filesystem root (POSIX).
 * - `search`   — anything else; fuzzy-rank against commands + projects + threads.
 */
export type PaletteMode = "root" | "actions" | "browse" | "drives" | "search";

const BROWSE_PREFIXES = ["/", "./", "../", ".\\", "..\\"] as const;

/** Test whether `s` begins with a Windows drive letter and colon (e.g. "C:" or "d:"). */
function startsWithWindowsDrive(s: string): boolean {
  return /^[A-Za-z]:/.test(s);
}

function isHomeBrowseQuery(query: string): boolean {
  return query === "~" || query.startsWith("~/") || query.startsWith("~\\");
}

function isPathBrowseQuery(query: string): boolean {
  return BROWSE_PREFIXES.some((prefix) => query.startsWith(prefix)) || startsWithWindowsDrive(query);
}

const PALETTE_MODE_RULES: ReadonlyArray<{ mode: Exclude<PaletteMode, "search">; matches: (query: string) => boolean }> = [
  { mode: "root", matches: (query) => query.length === 0 },
  { mode: "actions", matches: (query) => query.startsWith(">") },
  { mode: "browse", matches: isHomeBrowseQuery },
  { mode: "drives", matches: (query) => query === "/" },
  { mode: "browse", matches: isPathBrowseQuery },
];

/**
 * Compute the palette mode from the raw input query.
 * The query is checked verbatim — leading whitespace is treated as plain text.
 */
export function getPaletteMode(query: string): PaletteMode {
  return PALETTE_MODE_RULES.find((rule) => rule.matches(query))?.mode ?? "search";
}

/** Returns true when the query represents any kind of filesystem path the picker should browse. */
export function isBrowseQuery(query: string): boolean {
  const mode = getPaletteMode(query);
  return mode === "browse" || mode === "drives";
}

/**
 * Result of splitting a browse query into a directory portion and a leaf filter.
 * `directoryPath` always ends in a separator (or is a bare drive root like `C:\`).
 * `leafFilter` is the partial segment after the final separator; may be empty.
 */
export interface BrowseQueryParts {
  directoryPath: string;
  leafFilter: string;
}

/**
 * Find the index of the last `/` or `\` in `s`. Returns -1 if there is none.
 */
function lastSeparatorIndex(s: string): number {
  const slash = s.lastIndexOf("/");
  const back = s.lastIndexOf("\\");
  return Math.max(slash, back);
}

/**
 * Split a browse-mode query into the directory it refers to and the partial
 * leaf segment used as a filter against that directory's entries.
 *
 * Examples:
 *   "~/projects/my-app" → { directoryPath: "~/projects/", leafFilter: "my-app" }
 *   "~/projects/"       → { directoryPath: "~/projects/", leafFilter: "" }
 *   "~"                 → { directoryPath: "~/",          leafFilter: "" }
 *   "C:\\Users\\Doc"    → { directoryPath: "C:\\Users\\", leafFilter: "Doc" }
 *   "C:\\"              → { directoryPath: "C:\\",        leafFilter: "" }
 */
export function splitBrowseQuery(query: string): BrowseQueryParts {
  if (query === "~") return { directoryPath: "~/", leafFilter: "" };

  // Bare drive root like "C:" or "C:\" — treat as the drive root with no leaf.
  if (/^[A-Za-z]:[\\/]?$/.test(query)) {
    const driveLetter = query[0];
    return { directoryPath: `${driveLetter}:\\`, leafFilter: "" };
  }

  // Drive-prefixed query without an absolute-path separator after the colon
  // (e.g. "C:Users", "C:Users\\Bob"). Windows users typing a drive letter often
  // start filtering immediately, and without this branch the generic separator
  // search below picks up the colon and produces a bogus drive-relative
  // "C:Users\\" directoryPath. Anchor the result at the drive root and
  // re-split the remainder so deeper queries still resolve correctly.
  if (/^[A-Za-z]:/.test(query) && !/^[A-Za-z]:[\\/]/.test(query)) {
    const driveLetter = query[0];
    const rest = query.slice(2);
    const idx = lastSeparatorIndex(rest);
    if (idx === -1) {
      return { directoryPath: `${driveLetter}:\\`, leafFilter: rest };
    }
    return {
      directoryPath: `${driveLetter}:\\${rest.slice(0, idx + 1)}`,
      leafFilter: rest.slice(idx + 1),
    };
  }

  const idx = lastSeparatorIndex(query);
  if (idx === -1) {
    // No separator at all — treat the whole query as a leaf relative to cwd.
    return { directoryPath: "./", leafFilter: query };
  }
  return {
    directoryPath: query.slice(0, idx + 1),
    leafFilter: query.slice(idx + 1),
  };
}

/**
 * Filter a list of directory entries to directories only, by a case-insensitive
 * substring match against the leaf filter. Hidden entries (name starts with `.`)
 * are included only when the filter itself starts with `.`.
 */
export function filterBrowseEntries(
  entries: { name: string; isDir: boolean }[],
  leafFilter: string,
): { name: string; isDir: boolean }[] {
  const lower = leafFilter.toLowerCase();
  const showHidden = lower.startsWith(".");
  return entries.filter((entry) => {
    if (!entry.isDir) return false;
    if (!showHidden && entry.name.startsWith(".")) return false;
    if (lower === "") return true;
    return entry.name.toLowerCase().includes(lower);
  });
}

/** Minimal workspace shape required by palette logic. Avoids a direct contracts import. */
export interface WorkspaceLike {
  /** Workspace identifier — number in legacy tests, ULID string in the live store. */
  id: number | string;
  /** Human-readable workspace name. */
  name: string;
  /** Absolute filesystem path. */
  path: string;
  /** Whether the workspace is pinned to the top of the list. */
  pinned: boolean;
  /** Timestamp of last open, or null if never. */
  lastOpenedAt: number | null;
  /** Whether the workspace root is a git repository. */
  isGitRepo: boolean;
  /** Creation timestamp (unix ms). */
  createdAt: number;
  /** Last-updated timestamp (unix ms). */
  updatedAt: number;
}

/** Minimal thread shape required by palette logic. */
export interface ThreadLike {
  /** Thread UUID. */
  id: string;
  /** Optional user-visible thread title. */
  title?: string | null;
  /**
   * ID of the workspace this thread belongs to. Number for legacy fixtures,
   * ULID string for the live store — coercing the ULID through `Number()`
   * produces `NaN`, so the type accepts both forms.
   */
  workspaceId: number | string;
  /** Creation timestamp (unix ms). */
  createdAt: number;
  /** Last-updated timestamp (unix ms). */
  updatedAt: number;
}

/**
 * Build palette items for a list of workspaces.
 * Each item matches on workspace name and path.
 */
export function buildProjectActionItems(workspaces: WorkspaceLike[]): PaletteItem[] {
  return workspaces.map((ws) => ({
    value: `workspace:${ws.id}`,
    title: ws.name,
    description: ws.path,
    searchTerms: [ws.name, ws.path],
  }));
}

/**
 * Build palette items for a list of threads.
 * Untitled threads fall back to the label "Untitled thread".
 */
export function buildThreadActionItems(threads: ThreadLike[]): PaletteItem[] {
  return threads.map((t) => {
    // Whitespace-only titles render as a blank palette row, which is a UI dead
    // zone the user can't visually identify. Trim and fall back to the same
    // placeholder we use for missing titles so every row carries a label.
    const trimmed = t.title?.trim();
    const title = trimmed ? trimmed : "Untitled thread";
    return {
      value: `thread:${t.id}`,
      title,
      description: undefined,
      searchTerms: [title.toLowerCase()],
    };
  });
}
