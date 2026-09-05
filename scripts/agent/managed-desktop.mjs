/** Launches the existing desktop lifecycle helpers through Electron's Node runtime. */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { resolveElectronBinary } from "../runtime/launch-mechanics.mjs";

const rootDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..", "..");
const skillRoot = NodePath.join(rootDir, ".agents", "skills", "electorn-live-testing", "scripts");
export const MANAGED_DESKTOP_SESSION_FILE = "electron-agent-runtime.json";

/** Starts the owned Electron desktop session for one managed runtime. */
export function startManagedDesktop(repoRoot, electronBin = resolveElectronBinary(rootDir)) {
  buildDesktopMain();
  return runDesktopHelper("start-electron.mjs", "startElectron", repoRoot, electronBin);
}

/** Stops the owned Electron desktop session for one managed runtime. */
export function stopManagedDesktop(repoRoot, electronBin = resolveElectronBinary(rootDir)) {
  return runDesktopHelper("stop-electron.mjs", "stopElectron", repoRoot, electronBin);
}

function buildDesktopMain() {
  NodeChildProcess.execFileSync(process.execPath, ["scripts/build-main.mjs", "--main-only"], {
    cwd: NodePath.join(rootDir, "apps", "desktop"),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
}

function runDesktopHelper(scriptName, exportName, repoRoot, electronBin) {
  if (!electronBin) throw new Error("Electron binary not found. Run 'bun install' in the project root.");
  const scriptUrl = NodeURL.pathToFileURL(NodePath.join(skillRoot, scriptName)).href;
  const source = [
    `import(${JSON.stringify(scriptUrl)}).then(async (helper) => {`,
    `const result = await helper.${exportName}(process.cwd(), { sessionFileName: ${JSON.stringify(MANAGED_DESKTOP_SESSION_FILE)} });`,
    "process.stdout.write(JSON.stringify(result));",
    "}).catch((error) => { console.error(error); process.exitCode = 1; });",
  ].join("");
  const output = NodeChildProcess.execFileSync(electronBin, ["-e", source], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
  });
  return JSON.parse(output);
}
