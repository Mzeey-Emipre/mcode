import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureElectronForPrebuild } from "../../electron-postinstall.mjs";
import { ELECTRON_INSTALL_TIMEOUT_MS } from "../../ensure-electron.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ensureElectronForPrebuild", () => {
  it("installs a missing Electron binary before resolving it", () => {
    const root = mkdtempSync(join(tmpdir(), "mcode-electron-postinstall-"));
    temporaryRoots.push(root);
    const desktopRoot = join(root, "apps", "desktop");
    const electronRoot = join(root, "node_modules", "electron");
    const executable = join(electronRoot, "dist", "electron.exe");

    mkdirSync(desktopRoot, { recursive: true });
    mkdirSync(electronRoot, { recursive: true });
    writeFileSync(join(desktopRoot, "package.json"), '{"private":true}');
    writeFileSync(
      join(electronRoot, "package.json"),
      '{"name":"electron","version":"0.0.0","main":"index.js"}',
    );
    writeFileSync(
      join(electronRoot, "index.js"),
      "const fs=require('fs');const path=require('path');" +
        "const executable=fs.readFileSync(path.join(__dirname,'path.txt'),'utf8').trim();" +
        "module.exports=path.join(__dirname,'dist',executable);",
    );
    writeFileSync(
      join(electronRoot, "install.js"),
      "const fs=require('fs');const path=require('path');" +
        "fs.mkdirSync(path.join(__dirname,'dist'),{recursive:true});" +
        "fs.writeFileSync(path.join(__dirname,'dist','electron.exe'),'fixture');" +
        "fs.writeFileSync(path.join(__dirname,'path.txt'),'electron.exe');",
    );

    assert.equal(existsSync(join(electronRoot, "path.txt")), false);
    assert.equal(ensureElectronForPrebuild(desktopRoot), executable);
    assert.equal(existsSync(join(electronRoot, "path.txt")), true);
    assert.equal(existsSync(executable), true);
  });

  it("times out a hanging Electron install.js process", () => {
    const root = mkdtempSync(join(tmpdir(), "mcode-electron-postinstall-timeout-"));
    temporaryRoots.push(root);
    const electronRoot = join(root, "node_modules", "electron");
    const runner = join(root, "run-install.mjs");

    mkdirSync(electronRoot, { recursive: true });
    writeFileSync(
      join(electronRoot, "install.js"),
      "setInterval(() => {}, 1_000);",
    );
    writeFileSync(
      runner,
      `import { runElectronInstall } from ${JSON.stringify(
        pathToFileURL(resolve(process.cwd(), "scripts", "ensure-electron.mjs")).href,
      )};\n` +
        `runElectronInstall(${JSON.stringify(electronRoot)}, 50);\n`,
    );

    assert.equal(ELECTRON_INSTALL_TIMEOUT_MS, 180_000);
    const result = spawnSync(process.execPath, [runner], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ETIMEDOUT/);
  });
});
