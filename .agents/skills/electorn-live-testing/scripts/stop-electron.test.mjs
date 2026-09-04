import * as NodeAssertStrict from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { stopElectron } from "./stop-electron.mjs";

NodeTest.test("cleans a stale owned Electron session record without terminating another process", () => {
  const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-stop-electron-"));
  const sessionFile = NodePath.join(repoRoot, ".dev", "electron-live-testing.json");
  NodeFS.mkdirSync(NodePath.dirname(sessionFile), { recursive: true });
  NodeFS.writeFileSync(sessionFile, JSON.stringify({
    pid: 2_147_483_647,
    debugPort: 9_222,
    executablePath: process.execPath,
    repoRoot,
  }));

  try {
    NodeAssertStrict.deepEqual(stopElectron(repoRoot), {
      pid: 2_147_483_647,
      status: "already-stopped",
    });
    NodeAssertStrict.equal(NodeFS.existsSync(sessionFile), false);
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});
