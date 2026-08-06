import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureElectronForPrebuild } from "../../electron-postinstall.mjs";

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
});
