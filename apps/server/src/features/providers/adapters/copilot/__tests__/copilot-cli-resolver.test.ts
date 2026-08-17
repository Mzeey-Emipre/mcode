import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import {
  resolveCopilotCli,
  clearResolutionCache,
  formatCopilotNotFoundMessage,
  type CopilotCliResolverIO,
} from "../copilot-cli-resolver.js";

/** Builds a seeded ResolverIO. `exec` keys are `[command, ...args].join(" ")`. */
function fakeIO(opts: {
  platform?: NodeJS.Platform;
  files?: Record<string, string>;
  existsExtra?: string[];
  exec?: Record<string, string | null>;
}): CopilotCliResolverIO {
  const files = opts.files ?? {};
  const existsSet = new Set([...Object.keys(files), ...(opts.existsExtra ?? [])]);
  const execMap = opts.exec ?? {};
  return {
    platform: opts.platform ?? "linux",
    exists: (p) => existsSet.has(p),
    readFile: (p) => (p in files ? files[p]! : null),
    exec: (command, args) => {
      const key = [command, ...args].join(" ");
      return key in execMap ? execMap[key]! : null;
    },
  };
}

const COPILOT_PKG = (version: string) =>
  JSON.stringify({ name: "@github/copilot", version });

/** Help text that satisfies the SDK capability probe via documented flags. */
const SDK_COMPAT_HELP = "  --headless  Run the CLI as a headless server";

/** Help text for 1.x CLIs that document `--acp` instead of `--headless`. */
const SDK_ACP_HELP = "  --acp  Start as Agent Client Protocol server";

/** Adds `--help` entries for CLI paths that should pass the SDK capability check. */
function withSdkHelp(exec: Record<string, string | null>, entries: string[]): Record<string, string | null> {
  const out = { ...exec };
  for (const entry of entries) {
    out[`${entry} --help`] = SDK_COMPAT_HELP;
  }
  return out;
}

describe("resolveCopilotCli", () => {
  beforeEach(() => {
    clearResolutionCache();
  });

  it("returns not-found with the @github/copilot install command when nothing resolves", () => {
    const res = resolveCopilotCli({}, fakeIO({ platform: "linux" }));
    expect(res.source).toBe("not-found");
    expect(res.entry).toBeNull();
    expect(res.version).toBeNull();
    if (res.source === "not-found") {
      expect(res.message).toContain("npm install -g @github/copilot");
    }
  });

  it("uses the configured path verbatim and probes its version", () => {
    const configured = "C:/tools/copilot.cmd";
    const io = fakeIO({
      platform: "win32",
      existsExtra: [configured],
      exec: withSdkHelp(
        { [`${configured} --version`]: "GitHub Copilot CLI 1.0.24." },
        [configured],
      ),
    });
    const res = resolveCopilotCli({ configuredPath: configured }, io);
    expect(res).toMatchObject({ source: "configured", entry: configured, version: "1.0.24" });
  });

  it("trusts the configured path when --version yields no semver", () => {
    const configured = "/usr/bin/copilot";
    const io = fakeIO({
      platform: "linux",
      existsExtra: [configured],
      exec: withSdkHelp(
        { [`${configured} --version`]: "weird output" },
        [configured],
      ),
    });
    const res = resolveCopilotCli({ configuredPath: configured }, io);
    expect(res).toMatchObject({ source: "configured", entry: configured, version: null });
  });

  it("rejects configured paths with shell metacharacters", () => {
    const res = resolveCopilotCli({ configuredPath: "copilot.cmd & calc.exe" }, fakeIO({}));
    expect(res.source).toBe("not-found");
    if (res.source === "not-found") {
      expect(res.message).toContain("invalid characters");
    }
  });

  it("accepts configured paths with spaces and parentheses", () => {
    const configured = "C:\\Program Files (x86)\\GitHub\\copilot\\index.js";
    const io = fakeIO({
      platform: "win32",
      exec: { [`${configured} --version`]: "GitHub Copilot CLI 1.0.57." },
      existsExtra: [configured],
    });
    const res = resolveCopilotCli({ configuredPath: configured }, io);
    expect(res).toMatchObject({ source: "configured", entry: configured, version: "1.0.57" });
  });

  it("falls through when the configured path is missing and npm-global resolves", () => {
    const pkgDir = join("/global", "@github", "copilot");
    const entry = join(pkgDir, "index.js");
    const io = fakeIO({
      platform: "linux",
      exec: withSdkHelp({ "npm root -g": "/global" }, [entry]),
      files: { [join(pkgDir, "package.json")]: COPILOT_PKG("1.0.24") },
      existsExtra: [entry],
    });
    const res = resolveCopilotCli({ configuredPath: "/missing/copilot" }, io);
    expect(res).toMatchObject({ source: "npm-global", entry, version: "1.0.24" });
  });

  it("falls through when the configured path does not respond to --version", () => {
    const configured = "/usr/bin/copilot";
    const pkgDir = join("/global", "@github", "copilot");
    const entry = join(pkgDir, "index.js");
    const io = fakeIO({
      platform: "linux",
      existsExtra: [configured, entry],
      exec: withSdkHelp({ "npm root -g": "/global" }, [entry]),
      files: { [join(pkgDir, "package.json")]: COPILOT_PKG("1.0.24") },
    });
    const res = resolveCopilotCli({ configuredPath: configured }, io);
    expect(res).toMatchObject({ source: "npm-global", entry, version: "1.0.24" });
  });

  it("ignores a blank configured path and falls through", () => {
    const res = resolveCopilotCli({ configuredPath: "   " }, fakeIO({}));
    expect(res.source).toBe("not-found");
  });

  it("resolves @github/copilot via npm root -g to index.js, version from package.json", () => {
    const pkgDir = join("/global", "@github", "copilot");
    const entry = join(pkgDir, "index.js");
    const io = fakeIO({
      platform: "linux",
      exec: withSdkHelp({ "npm root -g": "/global" }, [entry]),
      files: { [join(pkgDir, "package.json")]: COPILOT_PKG("1.0.24") },
      existsExtra: [entry],
    });
    const res = resolveCopilotCli({}, io);
    expect(res).toMatchObject({ source: "npm-global", entry, version: "1.0.24" });
  });

  it("accepts 1.x when version qualifies even if --help only lists --acp", () => {
    const pkgDir = join("/global", "@github", "copilot");
    const entry = join(pkgDir, "index.js");
    const io = fakeIO({
      platform: "linux",
      exec: {
        "npm root -g": "/global",
        [`${entry} --help`]: SDK_ACP_HELP,
      },
      files: { [join(pkgDir, "package.json")]: COPILOT_PKG("1.0.56") },
      existsExtra: [entry],
    });
    const res = resolveCopilotCli({}, io);
    expect(res).toMatchObject({ source: "npm-global", entry, version: "1.0.56" });
  });

  it("rejects an SDK-incompatible CLI below the minimum 0.0.x build", () => {
    const pkgDir = join("/global", "@github", "copilot");
    const entry = join(pkgDir, "index.js");
    const io = fakeIO({
      platform: "linux",
      exec: {
        "npm root -g": "/global",
        [`${entry} --help`]: "Usage: copilot [options] [command]",
      },
      files: { [join(pkgDir, "package.json")]: COPILOT_PKG("0.0.330") },
      existsExtra: [entry],
    });
    const res = resolveCopilotCli({}, io);
    expect(res.source).toBe("not-found");
    if (res.source === "not-found") {
      expect(res.message).toContain("0.0.330");
      expect(res.message).toContain("npm install -g @github/copilot@latest");
    }
  });

  it("falls through when npm root -g resolves but index.js is absent", () => {
    const pkgDir = join("/global", "@github", "copilot");
    const io = fakeIO({
      platform: "linux",
      exec: { "npm root -g": "/global" },
      files: { [join(pkgDir, "package.json")]: COPILOT_PKG("1.0.24") },
    });
    expect(resolveCopilotCli({}, io).source).toBe("not-found");
  });

  it("falls through when package.json name is not @github/copilot", () => {
    const pkgDir = join("/global", "@github", "copilot");
    const entry = join(pkgDir, "index.js");
    const io = fakeIO({
      platform: "linux",
      exec: { "npm root -g": "/global" },
      files: { [join(pkgDir, "package.json")]: JSON.stringify({ name: "evil-pkg", version: "1.0.0" }) },
      existsExtra: [entry],
    });
    expect(resolveCopilotCli({}, io).source).toBe("not-found");
  });

  it("falls through when npm is unavailable", () => {
    expect(resolveCopilotCli({}, fakeIO({ platform: "linux" })).source).toBe("not-found");
  });

  it("follows a win32 .ps1 shim to the adjacent package index.js (PowerShell-aware)", () => {
    const binDir = join("C:/scoop/bin");
    const shim = join(binDir, "copilot.ps1");
    const pkgDir = join(binDir, "node_modules", "@github", "copilot");
    const entry = join(pkgDir, "index.js");
    const io = fakeIO({
      platform: "win32",
      exec: withSdkHelp(
        { "powershell -NoProfile -Command (Get-Command copilot).Source": shim },
        [entry],
      ),
      files: { [join(pkgDir, "package.json")]: COPILOT_PKG("1.0.24") },
      existsExtra: [entry],
    });
    const res = resolveCopilotCli({}, io);
    expect(res).toMatchObject({ source: "path-shim", entry, version: "1.0.24" });
  });

  it("falls back to where.exe on win32 when PowerShell does not resolve copilot", () => {
    const binDir = join("C:/tools/bin");
    const shim = join(binDir, "copilot.cmd");
    const pkgDir = join(binDir, "node_modules", "@github", "copilot");
    const entry = join(pkgDir, "index.js");
    const io = fakeIO({
      platform: "win32",
      exec: withSdkHelp({ "where copilot": shim }, [entry]),
      files: { [join(pkgDir, "package.json")]: COPILOT_PKG("1.0.24") },
      existsExtra: [entry],
    });
    const res = resolveCopilotCli({}, io);
    expect(res).toMatchObject({ source: "path-shim", entry, version: "1.0.24" });
  });

  it("resolves via posix which, following to the adjacent package index.js", () => {
    const binDir = "/usr/local/bin";
    const shim = join(binDir, "copilot");
    const pkgDir = join(binDir, "node_modules", "@github", "copilot");
    const entry = join(pkgDir, "index.js");
    const io = fakeIO({
      platform: "linux",
      exec: withSdkHelp({ "which copilot": shim }, [entry]),
      files: { [join(pkgDir, "package.json")]: COPILOT_PKG("1.0.24") },
      existsExtra: [entry],
    });
    const res = resolveCopilotCli({}, io);
    expect(res).toMatchObject({ source: "path-shim", entry, version: "1.0.24" });
  });

  it("falls through when the shim has no adjacent package", () => {
    const io = fakeIO({ platform: "linux", exec: { "which copilot": "/usr/local/bin/copilot" } });
    expect(resolveCopilotCli({}, io).source).toBe("not-found");
  });

  it("disambiguates gh copilot when only the gh extension is present", () => {
    const io = fakeIO({ platform: "linux", exec: { "gh extension list": "github/gh-copilot  v1.0.0" } });
    const res = resolveCopilotCli({}, io);
    expect(res.source).toBe("not-found");
    if (res.source === "not-found") {
      expect(res.message).toContain("gh copilot");
      expect(res.message).toContain("@github/copilot");
    }
  });

  it("omits the gh-copilot note when the extension is absent", () => {
    const res = resolveCopilotCli({}, fakeIO({ platform: "linux" }));
    if (res.source === "not-found") {
      expect(res.message).not.toContain("gh copilot");
    }
  });

  it("reuses cached resolution within the TTL", () => {
    const io = fakeIO({ platform: "linux" });
    const first = resolveCopilotCli({}, io);
    const second = resolveCopilotCli({}, io);
    expect(first).toEqual(second);
  });
});

describe("formatCopilotNotFoundMessage", () => {
  it("includes gh copilot disambiguation when requested", () => {
    expect(formatCopilotNotFoundMessage(true)).toContain("gh copilot");
  });

  it("omits gh copilot disambiguation when absent", () => {
    expect(formatCopilotNotFoundMessage(false)).not.toContain("gh copilot");
  });
});

export { fakeIO };
