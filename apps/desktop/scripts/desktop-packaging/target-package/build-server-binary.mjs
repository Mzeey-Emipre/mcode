import { copyFile, mkdir, chmod, readFile, writeFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Resolve where the Electron binary lives in the packaged output and
 * where the renamed copy should be written, per platform.
 *
 * @param {object} args
 * @param {string} args.appOutDir - electron-builder afterPack appOutDir.
 * @param {"win32"|"darwin"|"linux"|"mas"|string} args.electronPlatformName
 * @param {string} args.productFilename - filename (no extension) of the main app binary.
 * @param {string} [args.executableName] - Linux executable name (defaults to productFilename).
 * @returns {{ srcBinary: string, dstBinary: string }}
 */
export function resolveBinaryPaths({ appOutDir, electronPlatformName, productFilename, executableName }) {
  if (!productFilename || typeof productFilename !== "string") {
    throw new Error(
      `resolveBinaryPaths: productFilename is required (got ${productFilename === undefined ? "undefined" : JSON.stringify(productFilename)})`,
    );
  }
  if (electronPlatformName === "win32") {
    return {
      srcBinary: path.join(appOutDir, `${productFilename}.exe`),
      dstBinary: path.join(appOutDir, "resources", "bin", "mcode-server.exe"),
    };
  }
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    const appBundle = path.join(appOutDir, `${productFilename}.app`);
    return {
      srcBinary: path.join(appBundle, "Contents", "MacOS", productFilename),
      dstBinary: path.join(appBundle, "Contents", "Resources", "bin", "mcode-server"),
    };
  }
  // linux and any other Unix — electron-builder names the binary after
  // executableName (package.json "name"), not productName.
  return {
    srcBinary: path.join(appOutDir, executableName || productFilename),
    dstBinary: path.join(appOutDir, "resources", "bin", "mcode-server"),
  };
}

/**
 * Stamp Windows VERSIONINFO on an existing PE file using resedit.
 * Task Manager's "Name" column reads FileDescription, so this is what makes
 * the renamed binary show up as "Mcode Server" instead of "Electron".
 *
 * @param {string} exePath - absolute path to the .exe to modify in place
 * @param {object} info
 * @param {string} info.fileDescription
 * @param {string} info.productName
 * @param {string} info.companyName
 * @param {string} info.fileVersion - dotted quad e.g. "1.2.3.0"
 * @param {string} info.productVersion - dotted quad
 * @param {string} info.originalFilename
 * @param {string} [info.iconPath] - absolute path to a .ico; when set, its icons
 *   replace the binary's icon group so the server shows the app favicon.
 * @returns {Promise<void>}
 */
export async function stampWindowsVersionInfo(exePath, info) {
  const { NtExecutable, NtExecutableResource, Resource, Data } = await import("resedit");
  const buf = await readFile(exePath);
  const exe = NtExecutable.from(buf);
  const res = NtExecutableResource.from(exe);

  // resedit's primary documented API takes numeric components, even though
  // a string overload exists in the typings. Use the numeric form for
  // clarity. The caller is expected to have validated dotted-quad shape and
  // 16-bit segment bounds (see buildServerBinary win32 guard).
  const [fMajor, fMinor, fMicro, fRevision] = info.fileVersion.split(".").map(Number);
  const [pMajor, pMinor, pMicro, pRevision] = info.productVersion.split(".").map(Number);
  const versionInfo = Resource.VersionInfo.createEmpty();
  versionInfo.setFileVersion(fMajor, fMinor, fMicro, fRevision, 1033);
  versionInfo.setProductVersion(pMajor, pMinor, pMicro, pRevision, 1033);
  versionInfo.setStringValues(
    { lang: 1033, codepage: 1200 }, // en-US, Unicode
    {
      FileDescription: info.fileDescription,
      ProductName: info.productName,
      CompanyName: info.companyName,
      OriginalFilename: info.originalFilename,
      InternalName: info.originalFilename,
    },
  );
  versionInfo.outputToResourceEntries(res.entries);

  // The renamed copy inherits no usable icon, so Task Manager falls back to a
  // generic glyph. Stamp the app favicon onto the binary's icon group, reusing
  // the existing group id so Windows treats it as the executable icon.
  if (info.iconPath) {
    const iconBuf = await readFile(info.iconPath);
    const iconFile = Data.IconFile.from(iconBuf);
    const existingGroups = Resource.IconGroupEntry.fromEntries(res.entries);
    const iconGroupId = existingGroups.length > 0 ? existingGroups[0].id : 1;
    Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      iconGroupId,
      1033,
      iconFile.icons.map((icon) => icon.data),
    );
  }

  res.outputResource(exe);

  await writeFile(exePath, Buffer.from(exe.generate()));
}

/**
 * Copy the Electron binary to a renamed location so the spawned server
 * shows up as "mcode-server" / "Mcode Server" in process viewers.
 * On Windows, also stamps VERSIONINFO so Task Manager shows "Mcode Server"
 * in the Name column instead of "Electron".
 *
 * @param {object} args
 * @param {string} args.appOutDir
 * @param {"win32"|"darwin"|"linux"|"mas"|string} args.electronPlatformName
 * @param {string} args.productFilename
 * @param {string} [args.executableName] - Linux executable name (defaults to productFilename).
 * @param {string} [args.appVersion] - dotted quad like "1.2.3.0"; required on win32
 * @param {string} [args.companyName] - default "Mcode"
 * @param {string} [args.iconPath] - absolute path to a .ico stamped onto the
 *   win32 binary so it shows the app favicon instead of a generic icon.
 */
export async function buildServerBinary({
  appOutDir,
  electronPlatformName,
  productFilename,
  executableName,
  appVersion,
  companyName = "Mcode",
  iconPath,
}) {
  const { srcBinary, dstBinary } = resolveBinaryPaths({
    appOutDir,
    electronPlatformName,
    productFilename,
    executableName,
  });
  await copyRenamedServerBinary(srcBinary, dstBinary, electronPlatformName);
  await signMacServerBinary(dstBinary, electronPlatformName);
  await copyRequiredElectronResources(srcBinary, dstBinary, appOutDir, productFilename, electronPlatformName);
  await createMacFrameworksLink(appOutDir, productFilename, electronPlatformName);
  await copyLinuxFfmpegLibrary(srcBinary, dstBinary, electronPlatformName);
  await stampWindowsServerBinary(dstBinary, electronPlatformName, appVersion, companyName, iconPath);
}

function isMacElectronPlatform(electronPlatformName) {
  return electronPlatformName === "darwin" || electronPlatformName === "mas";
}

async function copyRenamedServerBinary(srcBinary, dstBinary, electronPlatformName) {
  await mkdir(path.dirname(dstBinary), { recursive: true });
  await copyFile(srcBinary, dstBinary);
  if (electronPlatformName !== "win32") await chmod(dstBinary, 0o755);
}

async function signMacServerBinary(dstBinary, electronPlatformName) {
  if (!isMacElectronPlatform(electronPlatformName)) return;
  execFileSync("codesign", ["--sign", "-", "--force", dstBinary]);
  console.log(`[build-server-binary] Ad-hoc signed ${dstBinary}`);
}

async function copyRequiredElectronResources(srcBinary, dstBinary, appOutDir, productFilename, electronPlatformName) {
  const macResourceDir = isMacElectronPlatform(electronPlatformName)
    ? path.join(appOutDir, `${productFilename}.app`, "Contents", "Frameworks", "Electron Framework.framework", "Resources")
    : null;
  await copyElectronResource(macResourceDir ?? path.dirname(srcBinary), path.dirname(dstBinary), "icudtl.dat", true);
  await copyElectronResource(macResourceDir ?? path.dirname(srcBinary), path.dirname(dstBinary), "v8_context_snapshot.bin", false);
}

async function copyElectronResource(sourceDir, destinationDir, fileName, required) {
  const source = path.join(sourceDir, fileName);
  if (!existsSync(source)) {
    if (required) console.warn(`[build-server-binary] ${fileName} not found at ${source}, server may fail to start`);
    return;
  }
  const destination = path.join(destinationDir, fileName);
  await copyFile(source, destination);
  console.log(`[build-server-binary] Copied ${fileName} to ${destination}`);
}

async function createMacFrameworksLink(appOutDir, productFilename, electronPlatformName) {
  if (!isMacElectronPlatform(electronPlatformName)) return;
  const frameworksLink = path.join(appOutDir, `${productFilename}.app`, "Contents", "Resources", "Frameworks");
  if (existsSync(frameworksLink)) return;
  await symlink("../Frameworks", frameworksLink);
  console.log(`[build-server-binary] Created Frameworks symlink at ${frameworksLink}`);
}

async function copyLinuxFfmpegLibrary(srcBinary, dstBinary, electronPlatformName) {
  if (electronPlatformName !== "linux") return;
  await copyElectronResource(path.dirname(srcBinary), path.dirname(dstBinary), "libffmpeg.so", false);
}

async function stampWindowsServerBinary(dstBinary, electronPlatformName, appVersion, companyName, iconPath) {
  if (electronPlatformName !== "win32") return;
  if (!appVersion) {
    throw new Error("buildServerBinary: appVersion is required when electronPlatformName is win32");
  }
    // VERSIONINFO numeric fields require a dotted quad of integers, each
    // bounded to 16 bits (HIWORD/LOWORD of dwFileVersionMS/LS). Catch upstream
    // callers that forgot to normalize semver prerelease suffixes or that
    // produced out-of-range values, before they reach resedit (which clamps
    // silently and would emit a corrupted resource).
    const isDottedQuad = /^\d+\.\d+\.\d+\.\d+$/.test(appVersion);
    const segmentsInRange =
      isDottedQuad &&
      appVersion.split(".").every((part) => {
        const n = Number(part);
        return Number.isInteger(n) && n >= 0 && n <= 65535;
      });
  if (!segmentsInRange) {
    throw new Error(
      `buildServerBinary: appVersion must be a numeric dotted quad with each segment in [0, 65535] on win32 (got ${JSON.stringify(appVersion)})`,
    );
  }
  await stampWindowsVersionInfo(dstBinary, {
    fileDescription: "Mcode Server",
    productName: "Mcode Server",
    companyName,
    fileVersion: appVersion,
    productVersion: appVersion,
    originalFilename: "mcode-server.exe",
    iconPath,
  });
}
