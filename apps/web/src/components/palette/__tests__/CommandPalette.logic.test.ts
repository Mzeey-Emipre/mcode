import { describe, it, expect } from "vitest";
import {
  normalizeQuery,
  rankSearchFieldMatch,
  filterCommandPaletteGroups,
  buildProjectActionItems,
  buildThreadActionItems,
  getPaletteMode,
  splitBrowseQuery,
  filterBrowseEntries,
} from "../CommandPalette.logic";

describe("normalizeQuery", () => {
  it("trims, lowercases, collapses whitespace", () => {
    expect(normalizeQuery("  Foo   BAR ")).toBe("foo bar");
  });
  it("returns empty string for blank input", () => {
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("rankSearchFieldMatch", () => {
  it("exact match returns 3", () => {
    expect(rankSearchFieldMatch("foo", "foo")).toBe(3);
  });
  it("prefix match returns 2", () => {
    expect(rankSearchFieldMatch("foobar", "foo")).toBe(2);
  });
  it("substring match returns 1", () => {
    expect(rankSearchFieldMatch("xfooy", "foo")).toBe(1);
  });
  it("no match returns -Infinity", () => {
    expect(rankSearchFieldMatch("nope", "foo")).toBe(-Infinity);
  });
  it("is case-insensitive", () => {
    expect(rankSearchFieldMatch("FOO", "foo")).toBe(3);
  });
});

describe("buildProjectActionItems", () => {
  const ws = {
    id: 1,
    name: "mcode",
    path: "/src/mcode",
    pinned: false,
    lastOpenedAt: null,
    isGitRepo: true,
    createdAt: 0,
    updatedAt: 0,
  };

  it("emits one item per workspace", () => {
    const out = buildProjectActionItems([ws]);
    expect(out).toHaveLength(1);
  });

  it("uses name + path as searchTerms", () => {
    const out = buildProjectActionItems([ws]);
    expect(out[0].searchTerms).toEqual(["mcode", "/src/mcode"]);
  });

  it("sets title to workspace name", () => {
    const out = buildProjectActionItems([ws]);
    expect(out[0].title).toBe("mcode");
  });

  it("sets description to workspace path", () => {
    const out = buildProjectActionItems([ws]);
    expect(out[0].description).toBe("/src/mcode");
  });
});

describe("getPaletteMode", () => {
  it("returns 'root' for empty query", () => {
    expect(getPaletteMode("")).toBe("root");
  });
  it("returns 'actions' for '>' prefix", () => {
    expect(getPaletteMode(">tog")).toBe("actions");
    expect(getPaletteMode(">")).toBe("actions");
  });
  it("returns 'browse' for '~' alone", () => {
    expect(getPaletteMode("~")).toBe("browse");
  });
  it("returns 'browse' for '~/' and '~/path'", () => {
    expect(getPaletteMode("~/")).toBe("browse");
    expect(getPaletteMode("~/projects")).toBe("browse");
  });
  it("returns 'drives' for exactly '/'", () => {
    expect(getPaletteMode("/")).toBe("drives");
  });
  it("returns 'browse' for unix-absolute path", () => {
    expect(getPaletteMode("/foo")).toBe("browse");
    expect(getPaletteMode("/foo/bar")).toBe("browse");
  });
  it("returns 'browse' for relative paths", () => {
    expect(getPaletteMode("./x")).toBe("browse");
    expect(getPaletteMode("../y")).toBe("browse");
    expect(getPaletteMode(".\\x")).toBe("browse");
    expect(getPaletteMode("..\\y")).toBe("browse");
  });
  it("returns 'browse' for windows absolute paths", () => {
    expect(getPaletteMode("C:\\Users")).toBe("browse");
    expect(getPaletteMode("c:/users")).toBe("browse");
    expect(getPaletteMode("D:\\")).toBe("browse");
  });
  it("returns 'search' for plain text", () => {
    expect(getPaletteMode("hello")).toBe("search");
    expect(getPaletteMode("new thread")).toBe("search");
  });
});

describe("splitBrowseQuery", () => {
  it("splits a unix-style path with trailing slash", () => {
    expect(splitBrowseQuery("~/projects/")).toEqual({
      directoryPath: "~/projects/",
      leafFilter: "",
    });
  });
  it("splits a unix-style path with partial leaf", () => {
    expect(splitBrowseQuery("~/projects/my-app")).toEqual({
      directoryPath: "~/projects/",
      leafFilter: "my-app",
    });
  });
  it("treats '~' alone as home with no leaf", () => {
    expect(splitBrowseQuery("~")).toEqual({
      directoryPath: "~/",
      leafFilter: "",
    });
  });
  it("splits a windows absolute path with backslash separators", () => {
    expect(splitBrowseQuery("C:\\Users\\cjnwo\\Doc")).toEqual({
      directoryPath: "C:\\Users\\cjnwo\\",
      leafFilter: "Doc",
    });
  });
  it("preserves the bare drive root form", () => {
    expect(splitBrowseQuery("C:\\")).toEqual({
      directoryPath: "C:\\",
      leafFilter: "",
    });
  });
  it("handles relative paths", () => {
    expect(splitBrowseQuery("./src/comp")).toEqual({
      directoryPath: "./src/",
      leafFilter: "comp",
    });
  });
  it("treats drive-prefixed leaf without separator as drive-root + leaf", () => {
    expect(splitBrowseQuery("C:Users")).toEqual({
      directoryPath: "C:\\",
      leafFilter: "Users",
    });
  });
  it("anchors drive-relative queries with separators to the drive root", () => {
    expect(splitBrowseQuery("C:Users\\Bob")).toEqual({
      directoryPath: "C:\\Users\\",
      leafFilter: "Bob",
    });
    expect(splitBrowseQuery("D:foo/bar")).toEqual({
      directoryPath: "D:\\foo/",
      leafFilter: "bar",
    });
  });
});

describe("buildThreadActionItems", () => {
  it("uses 'Untitled thread' fallback when title is missing", () => {
    const items = buildThreadActionItems([
      { id: "t1", title: null, workspaceId: 1, createdAt: 0, updatedAt: 0 },
    ]);
    expect(items[0].title).toBe("Untitled thread");
    expect(items[0].searchTerms).toEqual(["untitled thread"]);
  });
  it("uses 'Untitled thread' fallback for whitespace-only titles", () => {
    const items = buildThreadActionItems([
      { id: "t1", title: "   ", workspaceId: 1, createdAt: 0, updatedAt: 0 },
    ]);
    expect(items[0].title).toBe("Untitled thread");
  });
  it("trims surrounding whitespace from titles", () => {
    const items = buildThreadActionItems([
      { id: "t1", title: "  My thread  ", workspaceId: 1, createdAt: 0, updatedAt: 0 },
    ]);
    expect(items[0].title).toBe("My thread");
  });
});

describe("filterBrowseEntries", () => {
  const entries = [
    { name: "Documents", isDir: true },
    { name: "Downloads", isDir: true },
    { name: "Desktop", isDir: true },
    { name: ".bashrc", isDir: false },
    { name: ".config", isDir: true },
    { name: "Projects", isDir: true },
  ];

  it("returns all non-dotfile dirs when filter is empty", () => {
    const out = filterBrowseEntries(entries, "");
    expect(out.map((e) => e.name)).toEqual(["Documents", "Downloads", "Desktop", "Projects"]);
  });
  it("filters by case-insensitive substring", () => {
    const out = filterBrowseEntries(entries, "do");
    expect(out.map((e) => e.name)).toEqual(["Documents", "Downloads"]);
  });
  it("matches text after the beginning of a folder name", () => {
    const out = filterBrowseEntries(entries, "top");
    expect(out.map((e) => e.name)).toEqual(["Desktop"]);
  });
  it("shows hidden directories only when filter starts with '.'", () => {
    const out = filterBrowseEntries(entries, ".c");
    expect(out.map((e) => e.name)).toEqual([".config"]);
  });
  it("hides hidden directories when filter is empty", () => {
    const out = filterBrowseEntries(entries, "");
    expect(out.map((e) => e.name)).not.toContain(".config");
  });
  it("never includes hidden files even with dot filter", () => {
    const out = filterBrowseEntries(entries, ".b");
    expect(out.map((e) => e.name)).not.toContain(".bashrc");
  });
  it("never includes file entries", () => {
    const out = filterBrowseEntries(entries, "");
    expect(out.every((e) => e.isDir)).toBe(true);
  });
});

describe("filterCommandPaletteGroups", () => {
  const groups = [
    {
      heading: "Actions",
      items: [
        { value: "open-settings", title: "Open Settings", searchTerms: ["open settings", "settings"], description: undefined },
        { value: "new-thread", title: "New Thread", searchTerms: ["new thread", "thread"], description: undefined },
      ],
    },
  ];

  it("returns all groups when query is empty", () => {
    const result = filterCommandPaletteGroups(groups, "");
    expect(result[0].items).toHaveLength(2);
  });

  it("filters items by search term", () => {
    const result = filterCommandPaletteGroups(groups, "settings");
    expect(result[0].items).toHaveLength(1);
    expect(result[0].items[0].value).toBe("open-settings");
  });

  it("drops empty groups after filtering", () => {
    const result = filterCommandPaletteGroups(groups, "zzznomatch");
    expect(result).toHaveLength(0);
  });
});
