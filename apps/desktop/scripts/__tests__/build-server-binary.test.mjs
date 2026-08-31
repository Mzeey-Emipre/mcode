import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { buildServerBinary, resolveBinaryPaths } from "../desktop-packaging/target-package/build-server-binary.mjs";

// ---------------------------------------------------------------------------
// resedit mock — must be declared before any import that triggers the module
// ---------------------------------------------------------------------------
vi.mock("resedit", () => {
  const setFileVersion = vi.fn();
  const setProductVersion = vi.fn();
  const setStringValues = vi.fn();
  const outputToResourceEntries = vi.fn();
  const versionInstance = {
    setFileVersion,
    setProductVersion,
    setStringValues,
    outputToResourceEntries,
  };

  const VersionInfo = { createEmpty: vi.fn(() => versionInstance) };
  const fromEntries = vi.fn(() => []);
  const replaceIconsForResource = vi.fn();
  const IconGroupEntry = { fromEntries, replaceIconsForResource };
  const Resource = { VersionInfo, IconGroupEntry };

  const iconFileInstance = { icons: [{ data: new ArrayBuffer(4) }] };
  const Data = { IconFile: { from: vi.fn(() => iconFileInstance) } };

  const exeInstance = { generate: vi.fn(() => new ArrayBuffer(8)) };
  const NtExecutable = { from: vi.fn(() => exeInstance) };

  const resInstance = { entries: [], outputResource: vi.fn() };
  const NtExecutableResource = { from: vi.fn(() => resInstance) };

  return {
    NtExecutable,
    NtExecutableResource,
    Resource,
    Data,
    __mocks: {
      setFileVersion,
      setProductVersion,
      setStringValues,
      outputToResourceEntries,
      fromEntries,
      replaceIconsForResource,
      iconFileInstance,
      exeInstance,
      resInstance,
      versionInstance,
    },
  };
});

describe("resolveBinaryPaths", () => {
  it("Windows: copies <Product>.exe to resources\\bin\\mcode-server.exe", () => {
    const result = resolveBinaryPaths({
      appOutDir: "C:\\dist\\win-unpacked",
      electronPlatformName: "win32",
      productFilename: "Mcode",
    });
    expect(result.srcBinary).toBe(NodePath.join("C:\\dist\\win-unpacked", "Mcode.exe"));
    expect(result.dstBinary).toBe(
      NodePath.join("C:\\dist\\win-unpacked", "resources", "bin", "mcode-server.exe"),
    );
  });

  it("macOS: copies <Product>.app/Contents/MacOS/<Product> to Contents/Resources/bin/mcode-server", () => {
    const result = resolveBinaryPaths({
      appOutDir: "/dist/mac",
      electronPlatformName: "darwin",
      productFilename: "MCode",
    });
    expect(result.srcBinary).toBe(NodePath.join("/dist/mac", "MCode.app", "Contents", "MacOS", "MCode"));
    expect(result.dstBinary).toBe(
      NodePath.join("/dist/mac", "MCode.app", "Contents", "Resources", "bin", "mcode-server"),
    );
  });

  it("mas (Mac App Store) treated like darwin", () => {
    const result = resolveBinaryPaths({
      appOutDir: "/dist/mas",
      electronPlatformName: "mas",
      productFilename: "MCode",
    });
    expect(result.srcBinary).toBe(NodePath.join("/dist/mas", "MCode.app", "Contents", "MacOS", "MCode"));
    expect(result.dstBinary).toBe(
      NodePath.join("/dist/mas", "MCode.app", "Contents", "Resources", "bin", "mcode-server"),
    );
  });

  it("throws when productFilename is missing", () => {
    expect(() =>
      resolveBinaryPaths({
        appOutDir: "/x",
        electronPlatformName: "linux",
        productFilename: undefined,
      }),
    ).toThrow(/productFilename is required/);
  });

  it("throws when productFilename is not a string", () => {
    expect(() =>
      resolveBinaryPaths({
        appOutDir: "/x",
        electronPlatformName: "linux",
        productFilename: 42,
      }),
    ).toThrow(/productFilename is required/);
  });

  it("Linux: copies <appOutDir>/<exe> to <appOutDir>/resources/bin/mcode-server", () => {
    const result = resolveBinaryPaths({
      appOutDir: "/dist/linux-unpacked",
      electronPlatformName: "linux",
      productFilename: "mcode",
    });
    expect(result.srcBinary).toBe(NodePath.join("/dist/linux-unpacked", "mcode"));
    expect(result.dstBinary).toBe(NodePath.join("/dist/linux-unpacked", "resources", "bin", "mcode-server"));
  });
});

describe("buildServerBinary (copy + chmod)", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "build-server-binary-"));
  });

  afterEach(async () => {
    await NodeFSPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it("copies the source binary to the destination and makes it executable on Unix", async () => {
    const srcBinary = NodePath.join(tmpDir, "mcode");
    await NodeFSPromises.writeFile(srcBinary, "#!/usr/bin/env true\n", { mode: 0o755 });

    await buildServerBinary({
      appOutDir: tmpDir,
      electronPlatformName: "linux",
      productFilename: "mcode",
    });

    const dst = NodePath.join(tmpDir, "resources", "bin", "mcode-server");
    const dstContents = await NodeFSPromises.readFile(dst);
    const srcContents = await NodeFSPromises.readFile(srcBinary);
    expect(dstContents.equals(srcContents)).toBe(true);

    if (process.platform !== "win32") {
      const stats = await NodeFSPromises.stat(dst);
      expect(stats.mode & 0o100).toBeTruthy();
    }
  });

  it("creates the destination directory if it does not exist", async () => {
    const srcBinary = NodePath.join(tmpDir, "mcode");
    await NodeFSPromises.writeFile(srcBinary, "x", { mode: 0o755 });

    await buildServerBinary({
      appOutDir: tmpDir,
      electronPlatformName: "linux",
      productFilename: "mcode",
    });

    const dst = NodePath.join(tmpDir, "resources", "bin", "mcode-server");
    const dstStat = await NodeFSPromises.stat(dst);
    expect(dstStat.isFile()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stampWindowsVersionInfo tests
// ---------------------------------------------------------------------------
describe("stampWindowsVersionInfo", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stamp-version-info-"));
    // Reset all mock call counts before each test
    const { __mocks, NtExecutable, NtExecutableResource, Resource } = await import("resedit");
    vi.clearAllMocks();
    // Re-wire return values after clearAllMocks
    NtExecutable.from.mockReturnValue(__mocks.exeInstance);
    NtExecutableResource.from.mockReturnValue(__mocks.resInstance);
    Resource.VersionInfo.createEmpty.mockReturnValue(__mocks.versionInstance);
    __mocks.exeInstance.generate.mockReturnValue(new ArrayBuffer(8));
  });

  afterEach(async () => {
    await NodeFSPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads the exe file, stamps VERSIONINFO, and writes it back", async () => {
    const { stampWindowsVersionInfo } = await import("../desktop-packaging/target-package/build-server-binary.mjs");
    const {
      __mocks: { setFileVersion, setProductVersion, setStringValues, outputToResourceEntries, exeInstance, resInstance },
      NtExecutable,
      NtExecutableResource,
      Resource,
    } = await import("resedit");

    const exePath = NodePath.join(tmpDir, "mcode-server.exe");
    await NodeFSPromises.writeFile(exePath, Buffer.from([0x4d, 0x5a])); // minimal PE stub bytes

    await stampWindowsVersionInfo(exePath, {
      fileDescription: "Mcode Server",
      productName: "Mcode Server",
      companyName: "Mcode",
      fileVersion: "1.2.3.0",
      productVersion: "1.2.3.0",
      originalFilename: "mcode-server.exe",
    });

    // Verify call chain order via call counts
    expect(NtExecutable.from).toHaveBeenCalledTimes(1);
    expect(NtExecutableResource.from).toHaveBeenCalledWith(exeInstance);
    expect(Resource.VersionInfo.createEmpty).toHaveBeenCalledTimes(1);

    // setFileVersion and setProductVersion called with numeric components
    // (major, minor, micro, revision, langId)
    expect(setFileVersion).toHaveBeenCalledWith(1, 2, 3, 0, 1033);
    expect(setProductVersion).toHaveBeenCalledWith(1, 2, 3, 0, 1033);

    // setStringValues called with language object and string values
    expect(setStringValues).toHaveBeenCalledWith(
      { lang: 1033, codepage: 1200 },
      expect.objectContaining({
        FileDescription: "Mcode Server",
        ProductName: "Mcode Server",
        CompanyName: "Mcode",
        OriginalFilename: "mcode-server.exe",
        InternalName: "mcode-server.exe",
      }),
    );

    // Resources written back and exe serialized
    expect(outputToResourceEntries).toHaveBeenCalledWith(resInstance.entries);
    expect(resInstance.outputResource).toHaveBeenCalledWith(exeInstance);
    expect(exeInstance.generate).toHaveBeenCalledTimes(1);

    // Verify the file was actually written back
    const written = await NodeFSPromises.readFile(exePath);
    expect(written.length).toBeGreaterThan(0);
  });

  it("passes companyName through to setStringValues", async () => {
    const { stampWindowsVersionInfo } = await import("../desktop-packaging/target-package/build-server-binary.mjs");
    const { __mocks: { setStringValues } } = await import("resedit");

    const exePath = NodePath.join(tmpDir, "mcode-server.exe");
    await NodeFSPromises.writeFile(exePath, Buffer.from([0x4d, 0x5a]));

    await stampWindowsVersionInfo(exePath, {
      fileDescription: "Mcode Server",
      productName: "Mcode Server",
      companyName: "Acme Corp",
      fileVersion: "2.0.0.0",
      productVersion: "2.0.0.0",
      originalFilename: "mcode-server.exe",
    });

    expect(setStringValues).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ CompanyName: "Acme Corp" }),
    );
  });

  it("stamps the favicon icon group when iconPath is provided", async () => {
    const { stampWindowsVersionInfo } = await import("../desktop-packaging/target-package/build-server-binary.mjs");
    const { __mocks: { fromEntries, replaceIconsForResource }, Data } = await import("resedit");

    const exePath = NodePath.join(tmpDir, "mcode-server.exe");
    await NodeFSPromises.writeFile(exePath, Buffer.from([0x4d, 0x5a]));
    const iconPath = NodePath.join(tmpDir, "icon.ico");
    await NodeFSPromises.writeFile(iconPath, Buffer.from([0x00, 0x00, 0x01, 0x00]));

    await stampWindowsVersionInfo(exePath, {
      fileDescription: "Mcode Server",
      productName: "Mcode Server",
      companyName: "Mcode",
      fileVersion: "1.0.0.0",
      productVersion: "1.0.0.0",
      originalFilename: "mcode-server.exe",
      iconPath,
    });

    expect(Data.IconFile.from).toHaveBeenCalledTimes(1);
    // No pre-existing groups in the mock → falls back to icon group id 1.
    expect(replaceIconsForResource).toHaveBeenCalledWith(
      expect.any(Array),
      1,
      1033,
      expect.any(Array),
    );
    expect(fromEntries).toHaveBeenCalledTimes(1);
  });

  it("skips icon stamping when iconPath is omitted", async () => {
    const { stampWindowsVersionInfo } = await import("../desktop-packaging/target-package/build-server-binary.mjs");
    const { __mocks: { replaceIconsForResource } } = await import("resedit");

    const exePath = NodePath.join(tmpDir, "mcode-server.exe");
    await NodeFSPromises.writeFile(exePath, Buffer.from([0x4d, 0x5a]));

    await stampWindowsVersionInfo(exePath, {
      fileDescription: "Mcode Server",
      productName: "Mcode Server",
      companyName: "Mcode",
      fileVersion: "1.0.0.0",
      productVersion: "1.0.0.0",
      originalFilename: "mcode-server.exe",
    });

    expect(replaceIconsForResource).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildServerBinary win32 integration: calls stampWindowsVersionInfo on win32
// ---------------------------------------------------------------------------
describe("buildServerBinary win32 VERSIONINFO stamping", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "build-server-win32-"));
    const { __mocks, NtExecutable, NtExecutableResource, Resource } = await import("resedit");
    vi.clearAllMocks();
    NtExecutable.from.mockReturnValue(__mocks.exeInstance);
    NtExecutableResource.from.mockReturnValue(__mocks.resInstance);
    Resource.VersionInfo.createEmpty.mockReturnValue(__mocks.versionInstance);
    __mocks.exeInstance.generate.mockReturnValue(new ArrayBuffer(8));
  });

  afterEach(async () => {
    await NodeFSPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it("calls stampWindowsVersionInfo when electronPlatformName is win32", async () => {
    const { __mocks: { setStringValues } } = await import("resedit");

    // Create a fake source .exe
    const srcExe = NodePath.join(tmpDir, "Mcode.exe");
    await NodeFSPromises.writeFile(srcExe, Buffer.from([0x4d, 0x5a]));

    await buildServerBinary({
      appOutDir: tmpDir,
      electronPlatformName: "win32",
      productFilename: "Mcode",
      appVersion: "1.3.0.0",
      companyName: "Mcode",
    });

    // resedit should have been invoked (stamp was called)
    expect(setStringValues).toHaveBeenCalledWith(
      { lang: 1033, codepage: 1200 },
      expect.objectContaining({
        FileDescription: "Mcode Server",
        ProductName: "Mcode Server",
        CompanyName: "Mcode",
        OriginalFilename: "mcode-server.exe",
      }),
    );
  });

  it("does NOT call stampWindowsVersionInfo on linux", async () => {
    const { __mocks: { setStringValues } } = await import("resedit");

    const srcBinary = NodePath.join(tmpDir, "mcode");
    await NodeFSPromises.writeFile(srcBinary, Buffer.from("ELF binary content"));

    await buildServerBinary({
      appOutDir: tmpDir,
      electronPlatformName: "linux",
      productFilename: "mcode",
      appVersion: "1.3.0.0",
    });

    expect(setStringValues).not.toHaveBeenCalled();
  });

  it("throws when appVersion is missing on win32", async () => {
    const srcExe = NodePath.join(tmpDir, "Mcode.exe");
    await NodeFSPromises.writeFile(srcExe, Buffer.from([0x4d, 0x5a]));

    await expect(
      buildServerBinary({
        appOutDir: tmpDir,
        electronPlatformName: "win32",
        productFilename: "Mcode",
        // appVersion intentionally omitted
      }),
    ).rejects.toThrow(/appVersion is required/);
  });

  it("throws when appVersion is not a numeric dotted quad on win32", async () => {
    const srcExe = NodePath.join(tmpDir, "Mcode.exe");
    await NodeFSPromises.writeFile(srcExe, Buffer.from([0x4d, 0x5a]));

    await expect(
      buildServerBinary({
        appOutDir: tmpDir,
        electronPlatformName: "win32",
        productFilename: "Mcode",
        appVersion: "1.2.3-beta.1",
      }),
    ).rejects.toThrow(/numeric dotted quad/);
  });

  it("throws when an appVersion segment exceeds the 16-bit max on win32", async () => {
    const srcExe = NodePath.join(tmpDir, "Mcode.exe");
    await NodeFSPromises.writeFile(srcExe, Buffer.from([0x4d, 0x5a]));

    await expect(
      buildServerBinary({
        appOutDir: tmpDir,
        electronPlatformName: "win32",
        productFilename: "Mcode",
        appVersion: "1.2.3.999999",
      }),
    ).rejects.toThrow(/\[0, 65535\]/);
  });
});
