#!/usr/bin/env bun
/** Enforces the complexity limit for changed agent-refactor production functions. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const typescriptModule = await import(pathToFileURL(resolve(
  rootDir,
  "apps",
  "server",
  "node_modules",
  "typescript",
  "lib",
  "typescript.js",
)).href);
const ts = typescriptModule.default ?? typescriptModule;
const MAX_COMPLEXITY = 10;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const REFACTOR_PREFIXES = [
  "apps/server/src/features/agents/",
  "packages/providers/src/private/claude/",
  "packages/providers/src/private/codex/",
  "packages/providers/src/private/copilot/",
  "packages/providers/src/private/cursor/",
];

/** Returns whether a repository-relative file is production code in this refactor. */
export function isRefactorSource(file) {
  const normalized = file.replaceAll("\\", "/");
  return REFACTOR_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    && SOURCE_EXTENSIONS.has(normalized.slice(normalized.lastIndexOf(".")))
    && !normalized.includes("/__tests__/")
    && !normalized.endsWith(".test.ts")
    && !normalized.endsWith(".spec.ts");
}

/** Measures a function's cyclomatic complexity without entering nested functions. */
export function measureComplexity(node) {
  let complexity = 1;
  const visit = (child) => {
    if (child !== node && ts.isFunctionLike(child)) return;
    if (
      ts.isIfStatement(child)
      || ts.isConditionalExpression(child)
      || ts.isForStatement(child)
      || ts.isForInStatement(child)
      || ts.isForOfStatement(child)
      || ts.isWhileStatement(child)
      || ts.isDoStatement(child)
      || ts.isCatchClause(child)
      || ts.isCaseClause(child)
    ) {
      complexity += 1;
    }
    if (ts.isBinaryExpression(child) && ["&&", "||", "??"].includes(child.operatorToken.getText())) {
      complexity += 1;
    }
    ts.forEachChild(child, visit);
  };
  if (node.body) ts.forEachChild(node.body, visit);
  return complexity;
}

function git(args) {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8" });
}

function mergeBase() {
  try {
    return git(["merge-base", "HEAD", "main"]).trim();
  } catch {
    return "HEAD";
  }
}

function changedFiles(base) {
  const tracked = git(["diff", "--name-only", "--diff-filter=ACMR", base])
    .split(/\r?\n/)
    .filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].filter(isRefactorSource);
}

function changedLineRanges(file, base, isUntracked) {
  if (isUntracked) return [{ start: 1, end: Number.POSITIVE_INFINITY }];
  const patch = git(["diff", "--unified=0", base, "--", file]);
  return [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
    .flatMap((match) => {
      const start = Number(match[1]);
      const count = Number(match[2] ?? "1");
      return count === 0 ? [] : [{ start, end: start + count - 1 }];
    });
}

function functionName(node, sourceFile) {
  if (node.name) return node.name.getText(sourceFile);
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `<anonymous at line ${line}>`;
}

function functionsIn(sourceFile) {
  const functions = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node)) functions.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions;
}

function functionText(node, sourceFile) {
  return node.getText(sourceFile).replaceAll(/\s+/g, " ").trim();
}

function baselineFunctionTexts(base) {
  const files = git(["ls-tree", "-r", "--name-only", base])
    .split(/\r?\n/)
    .filter(isRefactorSource);
  const texts = new Set();
  for (const file of files) {
    const source = git(["show", `${base}:${file}`]);
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const node of functionsIn(sourceFile)) texts.add(functionText(node, sourceFile));
  }
  return texts;
}

function overlapsChangedLines(node, sourceFile, ranges) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return ranges.some((range) => range.start <= end && range.end >= start);
}

/** Finds changed production functions that exceed the repository's complexity limit. */
export function findComplexityViolations({ files, base = mergeBase() } = {}) {
  const candidates = files ?? changedFiles(base);
  const untracked = new Set(git(["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .filter(Boolean));
  const baselineFunctions = baselineFunctionTexts(base);
  const violations = [];
  for (const file of candidates.filter(isRefactorSource)) {
    const absolutePath = resolve(rootDir, file);
    if (!existsSync(absolutePath)) continue;
    const sourceFile = ts.createSourceFile(file, readFileSync(absolutePath, "utf8"), ts.ScriptTarget.Latest, true);
    const ranges = changedLineRanges(file, base, untracked.has(file));
    for (const node of functionsIn(sourceFile)) {
      if (!overlapsChangedLines(node, sourceFile, ranges)) continue;
      if (untracked.has(file) && baselineFunctions.has(functionText(node, sourceFile))) continue;
      const complexity = measureComplexity(node);
      if (complexity <= MAX_COMPLEXITY) continue;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      violations.push({ file, line, name: functionName(node, sourceFile), complexity });
    }
  }
  return violations;
}

function main() {
  const files = process.argv.slice(2).filter((argument) => !argument.startsWith("-"));
  const violations = findComplexityViolations({ files: files.length > 0 ? files : undefined });
  if (violations.length === 0) {
    console.log(`Agent refactor complexity: PASS (maximum ${MAX_COMPLEXITY}).`);
    return;
  }
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} ${violation.name} has complexity ${violation.complexity} (maximum ${MAX_COMPLEXITY}).`);
  }
  process.exitCode = 1;
}

if (relative(rootDir, fileURLToPath(import.meta.url)).replaceAll("\\", "/") === "scripts/agent/check-refactor-complexity.mjs") {
  main();
}
