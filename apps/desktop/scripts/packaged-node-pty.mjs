import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

const CONPTY_ARCHES = new Set(["x64", "arm64"]);
const CONPTY_RUNTIME_FILES = ["conpty.dll", "OpenConsole.exe"];

/**
 * Restores the ConPTY runtime files removed by electron-builder's node-pty rebuild.
 *
 * @param {{ nodePtyRoot: string, arch: string }} options
 * @returns {{ dllPath: string, openConsolePath: string }}
 */
export function ensurePackagedConptyRuntime({ nodePtyRoot, arch }) {
  if (!CONPTY_ARCHES.has(arch)) {
    throw new Error(`Unsupported Windows architecture for node-pty: ${arch}`);
  }

  const releaseDir = path.join(nodePtyRoot, "build", "Release");
  const bindingPath = path.join(releaseDir, "conpty.node");
  if (!existsSync(bindingPath)) {
    throw new Error(`Packaged node-pty binding is missing at ${bindingPath}`);
  }

  const thirdPartyRoot = path.join(nodePtyRoot, "third_party", "conpty");
  const sourceDirs = existsSync(thirdPartyRoot)
    ? readdirSync(thirdPartyRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(thirdPartyRoot, entry.name, `win10-${arch}`))
        .filter((candidate) =>
          CONPTY_RUNTIME_FILES.every((file) => existsSync(path.join(candidate, file))),
        )
    : [];

  if (sourceDirs.length !== 1) {
    throw new Error(
      `Could not find the ${arch} ConPTY runtime under ${thirdPartyRoot}`,
    );
  }

  const destinationDir = path.join(releaseDir, "conpty");
  mkdirSync(destinationDir, { recursive: true });
  for (const file of CONPTY_RUNTIME_FILES) {
    copyFileSync(path.join(sourceDirs[0], file), path.join(destinationDir, file));
  }

  return {
    dllPath: path.join(destinationDir, "conpty.dll"),
    openConsolePath: path.join(destinationDir, "OpenConsole.exe"),
  };
}
