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
 * Ensures the ConPTY runtime is beside the selected rebuilt or prebuilt binding.
 *
 * @param {{ nodePtyRoot: string, arch: string }} options
 * @returns {{ dllPath: string, openConsolePath: string }}
 */
export function ensurePackagedConptyRuntime({ nodePtyRoot, arch }) {
  if (!CONPTY_ARCHES.has(arch)) {
    throw new Error(`Unsupported Windows architecture for node-pty: ${arch}`);
  }

  const bindingDirs = [
    path.join(nodePtyRoot, "build", "Release"),
    path.join(nodePtyRoot, "prebuilds", `win32-${arch}`),
  ];
  const bindingDir = bindingDirs.find((candidate) =>
    existsSync(path.join(candidate, "conpty.node")),
  );
  if (!bindingDir) {
    throw new Error(
      `Packaged node-pty binding is missing from ${bindingDirs.join(" or ")}`,
    );
  }

  const destinationDir = path.join(bindingDir, "conpty");
  const destinationFiles = CONPTY_RUNTIME_FILES.map((file) =>
    path.join(destinationDir, file),
  );
  if (destinationFiles.every((file) => existsSync(file))) {
    return {
      dllPath: destinationFiles[0],
      openConsolePath: destinationFiles[1],
    };
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

  mkdirSync(destinationDir, { recursive: true });
  for (const file of CONPTY_RUNTIME_FILES) {
    copyFileSync(path.join(sourceDirs[0], file), path.join(destinationDir, file));
  }

  return {
    dllPath: path.join(destinationDir, "conpty.dll"),
    openConsolePath: path.join(destinationDir, "OpenConsole.exe"),
  };
}
