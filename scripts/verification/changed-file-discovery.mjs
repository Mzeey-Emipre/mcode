/** Discovers repository changes that can affect verification. */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
]);
const ROOT_VERIFICATION_FILES = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "turbo.json",
  ".claude/settings.json",
  ".codex/hooks.json",
  ".cursor/hooks.json",
  "scripts/vitest-global-setup.ts",
  "scripts/vitest-test-dir.ts",
]);

/** Returns whether a repository-relative path belongs to the verification runner. */
export function isVerificationScriptFile(file) {
  return file.startsWith("scripts/agent/") || file.startsWith("scripts/verification/");
}

/** Returns whether a repository-relative path can affect verification. */
export function isVerificationRelevant(file) {
  const normalized = file.replaceAll("\\", "/");
  if (isVerificationConfig(normalized)) return true;
  if (isVerificationScriptFile(normalized)) return true;
  if (NodePath.basename(normalized) === "package.json") return true;
  const dot = normalized.lastIndexOf(".");
  return dot >= 0 && CODE_EXTENSIONS.has(normalized.slice(dot));
}

/** Returns whether a path is verification configuration rather than test source. */
export function isVerificationConfig(file) {
  const name = NodePath.basename(file).toLowerCase();
  return ROOT_VERIFICATION_FILES.has(file) || isVerificationConfigName(name);
}

function isVerificationConfigName(name) {
  return ["package.json", "turbo.json", "bun.lock", "bun.lockb"].includes(name)
    || hasVerificationConfigPattern(name);
}

function hasVerificationConfigPattern(name) {
  return isTypeScriptConfig(name)
    || name.startsWith("eslint.config.")
    || name === ".eslintrc"
    || name.startsWith(".eslintrc.")
    || /^(?:vitest\.(?:config|workspace|setup)|vite\.config|(?:test-setup|setuptests))\./.test(name);
}

function isTypeScriptConfig(name) {
  return /^tsconfig(?:\.[^/]+)?\.json$/.test(name);
}

function parseNulPaths(raw) {
  return raw.split("\0").filter(Boolean);
}

/** Runs a Git command while retaining the verification runner's bounded output policy. */
export function git(args, cwd, encoding = "utf8") {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Lists verification-relevant committed, staged, unstaged, and untracked files.
 * Returns null when repository state cannot be inspected safely.
 */
export function getChangedFiles({ cwd = process.cwd() } = {}) {
  try {
    const seen = new Set();
    const add = (raw) => {
      for (const file of parseNulPaths(raw)) {
        if (isVerificationRelevant(file)) seen.add(file);
      }
    };
    add(git(["diff", "--name-only", "-z", "HEAD"], cwd));
    add(git(["ls-files", "--others", "--exclude-standard", "-z"], cwd));
    const mergeBase = git(["merge-base", "HEAD", "main"], cwd).trim();
    if (mergeBase) add(git(["diff", "--name-only", "-z", mergeBase, "HEAD"], cwd));
    return [...seen].sort();
  } catch {
    return null;
  }
}

/** Returns true when the current repository has verification-relevant changes. */
export function hasCodeChanges(options) {
  const files = getChangedFiles(options);
  return files === null || files.length > 0;
}
