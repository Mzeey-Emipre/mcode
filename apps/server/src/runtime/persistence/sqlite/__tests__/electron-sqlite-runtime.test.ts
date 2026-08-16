import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import type Database from "better-sqlite3";
import { openMemoryDatabase, resolveElectronNativeBinding } from "../database.js";
import { openElectronMemoryDatabase } from "./electron-sqlite.js";

describe("Electron SQLite test runtime", () => {
  let db: Database.Database | undefined;
  let temporaryResourcesPath: string | undefined;
  const binding = process.env.BETTER_SQLITE3_BINDING;
  const packagedResourcesRoot = process.env.MCODE_PACKAGED_RESOURCES_ROOT;
  const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");

  function createPackagedBinding(bindingName: string): string {
    if (!binding) throw new Error("BETTER_SQLITE3_BINDING is required for Electron SQLite tests");

    temporaryResourcesPath = mkdtempSync(join(tmpdir(), "mcode-sqlite-"));
    const packagedBinding = resolve(
      temporaryResourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      bindingName,
    );
    mkdirSync(dirname(packagedBinding), { recursive: true });
    copyFileSync(binding, packagedBinding);
    process.env.MCODE_PACKAGED_RESOURCES_ROOT = temporaryResourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: join(temporaryResourcesPath, "bin"),
      configurable: true,
    });
    return packagedBinding;
  }

  afterEach(() => {
    db?.close();
    db = undefined;
    if (binding === undefined) delete process.env.BETTER_SQLITE3_BINDING;
    else process.env.BETTER_SQLITE3_BINDING = binding;
    if (packagedResourcesRoot === undefined) delete process.env.MCODE_PACKAGED_RESOURCES_ROOT;
    else process.env.MCODE_PACKAGED_RESOURCES_ROOT = packagedResourcesRoot;
    if (resourcesPathDescriptor) Object.defineProperty(process, "resourcesPath", resourcesPathDescriptor);
    else delete (process as Record<string, unknown>).resourcesPath;
    if (temporaryResourcesPath) rmSync(temporaryResourcesPath, { recursive: true, force: true });
    temporaryResourcesPath = undefined;
  });

  it("runs in Electron Node and opens an in-memory database", () => {
    expect(process.versions.electron).toBeDefined();

    db = openMemoryDatabase();

    expect(db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
  });

  it("opens direct test databases with the Electron binding", () => {
    db = openElectronMemoryDatabase();

    expect(db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
  });

  it("rejects a missing native binding before loading SQLite", () => {
    delete process.env.BETTER_SQLITE3_BINDING;

    expect(() => openMemoryDatabase()).toThrow("BETTER_SQLITE3_BINDING must be");
  });

  it("accepts the canonical packaged Node binding", () => {
    const packagedBinding = createPackagedBinding("better_sqlite3.node");
    process.env.BETTER_SQLITE3_BINDING = packagedBinding;

    expect(resolveElectronNativeBinding()).toBe(realpathSync(packagedBinding));
  });

  it("rejects a packaged binding without an authoritative resources root", () => {
    const packagedBinding = createPackagedBinding("better_sqlite3.node");
    process.env.BETTER_SQLITE3_BINDING = packagedBinding;
    delete process.env.MCODE_PACKAGED_RESOURCES_ROOT;

    expect(() => resolveElectronNativeBinding()).toThrow("MCODE_PACKAGED_RESOURCES_ROOT");
  });

  it("rejects a packaged binding with a non-canonical resources root", () => {
    const packagedBinding = createPackagedBinding("better_sqlite3.node");
    process.env.BETTER_SQLITE3_BINDING = packagedBinding;
    process.env.MCODE_PACKAGED_RESOURCES_ROOT = `${temporaryResourcesPath}${process.platform === "win32" ? "\\\\." : "/."}`;

    expect(() => resolveElectronNativeBinding()).toThrow("MCODE_PACKAGED_RESOURCES_ROOT");
  });

  it("rejects an existing generic binding outside packaged resources", () => {
    createPackagedBinding("placeholder.node");
    const outsideBinding = resolve(tmpdir(), `mcode-sqlite-outside-${Date.now()}.node`);
    if (!binding) throw new Error("BETTER_SQLITE3_BINDING is required for Electron SQLite tests");
    copyFileSync(binding, outsideBinding);
    process.env.BETTER_SQLITE3_BINDING = outsideBinding;

    try {
      expect(() => resolveElectronNativeBinding()).toThrow("packaged binding");
    } finally {
      rmSync(outsideBinding, { force: true });
    }
  });

  it("rejects a packaged binding symlink that escapes the release directory", () => {
    const placeholder = createPackagedBinding("placeholder.node");
    const escapedBinding = join(dirname(placeholder), "better_sqlite3.node");
    if (!binding) throw new Error("BETTER_SQLITE3_BINDING is required for Electron SQLite tests");
    symlinkSync(binding, escapedBinding, "file");
    process.env.BETTER_SQLITE3_BINDING = escapedBinding;

    expect(() => resolveElectronNativeBinding()).toThrow("packaged binding");
  });

  it("rejects a packaged release directory symlink that escapes resources", () => {
    const placeholder = createPackagedBinding("placeholder.node");
    const releaseDir = dirname(placeholder);
    const escapedReleaseDir = mkdtempSync(join(tmpdir(), "mcode-sqlite-release-"));
    if (!binding) throw new Error("BETTER_SQLITE3_BINDING is required for Electron SQLite tests");
    copyFileSync(binding, join(escapedReleaseDir, "better_sqlite3.node"));
    rmSync(releaseDir, { recursive: true, force: true });
    symlinkSync(
      escapedReleaseDir,
      releaseDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    process.env.BETTER_SQLITE3_BINDING = join(releaseDir, "better_sqlite3.node");

    try {
      expect(() => resolveElectronNativeBinding()).toThrow("packaged binding");
    } finally {
      rmSync(escapedReleaseDir, { recursive: true, force: true });
    }
  });

  it("rejects an unexpected native binding path before loading SQLite", () => {
    process.env.BETTER_SQLITE3_BINDING = "C:/unexpected/better_sqlite3.electron.node";
    process.env.MCODE_PACKAGED_RESOURCES_ROOT = process.cwd();

    expect(() => openMemoryDatabase()).toThrow("packaged binding");
  });
});
