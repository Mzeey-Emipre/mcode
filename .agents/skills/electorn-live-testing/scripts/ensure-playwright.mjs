import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Creates an isolated Playwright installation under the worktree runtime directory. */
export function ensurePlaywright(repoRoot = process.cwd()) {
  const root = NodePath.resolve(repoRoot);
  const scratchDir = NodePath.join(root, ".dev", "playwright-scratch");
  const packageFile = NodePath.join(scratchDir, "package.json");
  const nodeModulesDir = NodePath.join(scratchDir, "node_modules");
  NodeFS.mkdirSync(scratchDir, { recursive: true });
  ensureScratchPackage(packageFile);
  const scratchRequire = NodeModule.createRequire(packageFile);
  if (isPlaywrightInstalled(scratchRequire, nodeModulesDir)) return nodeModulesDir;
  installPlaywright(scratchDir);
  if (waitForPlaywright(scratchRequire, nodeModulesDir)) return nodeModulesDir;
  throw new Error("Playwright was not installed inside the scratch package");
}

function ensureScratchPackage(packageFile) {
  if (NodeFS.existsSync(packageFile)) {
    const manifest = JSON.parse(NodeFS.readFileSync(packageFile, "utf8"));
    if (manifest.private !== true) {
      throw new Error("Refusing to modify a scratch package that is not private");
    }
    return;
  }
  NodeFS.writeFileSync(
    packageFile,
    `${JSON.stringify({ name: "mcode-electron-live-testing", private: true }, null, 2)}\n`,
    "utf8",
  );
}

function isPlaywrightInstalled(scratchRequire, nodeModulesDir) {
  try {
    return isInside(nodeModulesDir, scratchRequire.resolve("playwright"));
  } catch {
    // A missing local dependency is the expected installation trigger.
    return false;
  }
}

function installPlaywright(scratchDir) {
  const installer = process.versions.bun ? process.execPath : "bun";
  const install = NodeChildProcess.spawnSync(installer, ["add", "playwright"], {
    cwd: scratchDir,
    stdio: "inherit",
  });
  if (install.error) {
    throw new Error(`Playwright installation could not start: ${install.error.message}`);
  }
  if (install.status !== 0) {
    throw new Error(
      `Playwright installation failed with exit code ${install.status ?? "none"} and signal ${install.signal ?? "none"}`,
    );
  }
}

function waitForPlaywright(scratchRequire, nodeModulesDir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (isPlaywrightInstalled(scratchRequire, nodeModulesDir)) return true;
    // Bun can finish the child process before Windows exposes the installed files.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return false;
}

function isInside(parent, candidate) {
  const relativePath = NodePath.relative(parent, candidate);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !NodePath.isAbsolute(relativePath);
}

if (import.meta.main) {
  console.log(ensurePlaywright());
}
