import * as NodeTest from "node:test";
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { ensureElectronForPrebuild } from "../../electron-postinstall.mjs";
import { ELECTRON_INSTALL_TIMEOUT_MS } from "../../ensure-electron.mjs";

const temporaryRoots = [];

NodeTest.afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

NodeTest.describe("ensureElectronForPrebuild", () => {
  NodeTest.it("installs a missing Electron binary before resolving it", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-electron-postinstall-"));
    temporaryRoots.push(root);
    const desktopRoot = NodePath.join(root, "apps", "desktop");
    const electronRoot = NodePath.join(root, "node_modules", "electron");
    const executable = NodePath.join(electronRoot, "dist", "electron.exe");

    NodeFS.mkdirSync(desktopRoot, { recursive: true });
    NodeFS.mkdirSync(electronRoot, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(desktopRoot, "package.json"), '{"private":true}');
    NodeFS.writeFileSync(
      NodePath.join(electronRoot, "package.json"),
      '{"name":"electron","version":"0.0.0","main":"index.js"}',
    );
    NodeFS.writeFileSync(
      NodePath.join(electronRoot, "index.js"),
      "const fs=require('fs');const path=require('path');" +
        "const executable=fs.readFileSync(path.join(__dirname,'path.txt'),'utf8').trim();" +
        "module.exports=path.join(__dirname,'dist',executable);",
    );
    NodeFS.writeFileSync(
      NodePath.join(electronRoot, "install.js"),
      "const fs=require('fs');const path=require('path');" +
        "fs.mkdirSync(path.join(__dirname,'dist'),{recursive:true});" +
        "fs.writeFileSync(path.join(__dirname,'dist','electron.exe'),'fixture');" +
        "fs.writeFileSync(path.join(__dirname,'path.txt'),'electron.exe');",
    );

    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(electronRoot, "path.txt")), false);
    NodeAssertStrict.default.equal(ensureElectronForPrebuild(desktopRoot), executable);
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(electronRoot, "path.txt")), true);
    NodeAssertStrict.default.equal(NodeFS.existsSync(executable), true);
  });

  NodeTest.it("times out a hanging Electron install.js process", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-electron-postinstall-timeout-"));
    temporaryRoots.push(root);
    const electronRoot = NodePath.join(root, "node_modules", "electron");
    const runner = NodePath.join(root, "run-install.mjs");

    NodeFS.mkdirSync(electronRoot, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(electronRoot, "install.js"),
      "setInterval(() => {}, 1_000);",
    );
    NodeFS.writeFileSync(
      runner,
      `import { runElectronInstall } from ${JSON.stringify(
        NodeURL.pathToFileURL(NodePath.resolve(process.cwd(), "scripts", "ensure-electron.mjs")).href,
      )};\n` +
        `runElectronInstall(${JSON.stringify(electronRoot)}, 50);\n`,
    );

    NodeAssertStrict.default.equal(ELECTRON_INSTALL_TIMEOUT_MS, 180_000);
    const result = NodeChildProcess.spawnSync(process.execPath, [runner], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });

    NodeAssertStrict.default.equal(result.error, undefined, result.error?.message);
    NodeAssertStrict.default.notEqual(result.status, 0);
    NodeAssertStrict.default.match(result.stderr, /ETIMEDOUT/);
  });
});
