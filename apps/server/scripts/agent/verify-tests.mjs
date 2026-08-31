#!/usr/bin/env node
// Stub: forwards to the real verify-tests.mjs at the repo root.
// Exists so a stale Stop hook config running from apps/server cwd still resolves.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const target = NodePath.resolve(here, "../../../../scripts/agent/verify-tests.mjs");

const r = NodeChildProcess.spawnSync(process.execPath, [target], { stdio: "inherit" });
process.exit(r.status ?? 1);
