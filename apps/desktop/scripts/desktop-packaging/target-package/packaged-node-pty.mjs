import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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
    NodePath.join(nodePtyRoot, "build", "Release"),
    NodePath.join(nodePtyRoot, "prebuilds", `win32-${arch}`),
  ];
  const bindingDir = bindingDirs.find((candidate) =>
    NodeFS.existsSync(NodePath.join(candidate, "conpty.node")),
  );
  if (!bindingDir) {
    throw new Error(
      `Packaged node-pty binding is missing from ${bindingDirs.join(" or ")}`,
    );
  }

  const destinationDir = NodePath.join(bindingDir, "conpty");
  const destinationFiles = CONPTY_RUNTIME_FILES.map((file) =>
    NodePath.join(destinationDir, file),
  );
  if (destinationFiles.every((file) => NodeFS.existsSync(file))) {
    return {
      dllPath: destinationFiles[0],
      openConsolePath: destinationFiles[1],
    };
  }

  const thirdPartyRoot = NodePath.join(nodePtyRoot, "third_party", "conpty");
  const sourceDirs = NodeFS.existsSync(thirdPartyRoot)
    ? NodeFS.readdirSync(thirdPartyRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => NodePath.join(thirdPartyRoot, entry.name, `win10-${arch}`))
        .filter((candidate) =>
          CONPTY_RUNTIME_FILES.every((file) => NodeFS.existsSync(NodePath.join(candidate, file))),
        )
    : [];

  if (sourceDirs.length !== 1) {
    throw new Error(
      `Could not find the ${arch} ConPTY runtime under ${thirdPartyRoot}`,
    );
  }

  NodeFS.mkdirSync(destinationDir, { recursive: true });
  for (const file of CONPTY_RUNTIME_FILES) {
    NodeFS.copyFileSync(NodePath.join(sourceDirs[0], file), NodePath.join(destinationDir, file));
  }

  return {
    dllPath: NodePath.join(destinationDir, "conpty.dll"),
    openConsolePath: NodePath.join(destinationDir, "OpenConsole.exe"),
  };
}
