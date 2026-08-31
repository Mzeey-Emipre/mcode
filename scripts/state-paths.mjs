#!/usr/bin/env bun
/**
 * Print resolved runtime artifact paths for the current environment.
 * Useful for debugging where mcode stores its state.
 */
import * as NodePath from "node:path";
import { getMcodeDir } from "../packages/shared/src/index.ts";
import { resolveCliDbPath } from "./resolve-cli-db-path.mjs";

const dataDir = process.env.MCODE_DATA_DIR ?? getMcodeDir();
const dbPath = resolveCliDbPath();
const logDir = NodePath.join(dataDir, "logs");

console.log(`Data dir : ${dataDir}`);
console.log(`Database : ${dbPath}`);
console.log(`Logs     : ${logDir}`);
