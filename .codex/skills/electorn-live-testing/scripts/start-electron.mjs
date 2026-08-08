import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SESSION_FILE_NAME = "electron-live-testing.json";

/** Starts one detached Electron process with an agent-owned dynamic CDP endpoint. */
export async function startElectron(repoRoot = process.cwd()) {
  const root = resolve(repoRoot);
  const runtimeContract = await import(
    pathToFileURL(join(root, "scripts", "agent", "runtime-contract.mjs")).href
  );
  const paths = runtimeContract.getRuntimePaths(root);
  const ports = runtimeContract.readPortsFile(root);
  if (!ports) {
    throw new Error("Start the worktree runtime before launching Electron");
  }
  if (resolve(ports.worktreeIdentity).toLowerCase() !== root.toLowerCase()) {
    throw new Error("ports.json belongs to a different worktree");
  }

  const sessionFile = join(paths.devDir, SESSION_FILE_NAME);
  if (existsSync(sessionFile)) {
    const existing = JSON.parse(readFileSync(sessionFile, "utf8"));
    if (await isReusable(existing, root)) return existing;
    throw new Error(
      `A stale Electron session record exists at ${sessionFile}. Inspect its PID before removal.`,
    );
  }

  const preferredPort = runtimeContract.computeDeterministicPort(root, 43_000);
  const debugPort = await runtimeContract.findAvailablePort(preferredPort);
  const endpoint = `http://127.0.0.1:${debugPort}`;
  const desktopRoot = join(root, "apps", "desktop");
  const desktopEntry = join(desktopRoot, "dist", "main", "main.cjs");
  if (!existsSync(desktopEntry)) {
    throw new Error("Build the Electron main process before launching the session");
  }

  const desktopRequire = createRequire(join(desktopRoot, "package.json"));
  const executablePath = desktopRequire("electron");
  const userDataDir = join(paths.devDir, "electron-live-testing");
  const electronRuntimeDir = join(userDataDir, "runtime");
  const record = {
    debugPort,
    endpoint,
    executablePath,
    repoRoot: root,
    status: "starting",
    userDataDir,
  };
  writeFileSync(sessionFile, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  const stdout = openSync(join(paths.logsDir, "electron-live-testing.stdout.log"), "a");
  const stderr = openSync(join(paths.logsDir, "electron-live-testing.stderr.log"), "a");
  const env = {
    ...process.env,
    ...runtimeContract.buildRuntimeStateEnv(root, {
      MCODE_AGENT_FIXTURE_REPO: paths.fixtureRepoDir,
      MCODE_DATA_DIR: electronRuntimeDir,
      MCODE_DB_PATH: join(electronRuntimeDir, "db", "app.sqlite"),
      MCODE_ELECTRON_USER_DATA_DIR: userDataDir,
    }),
    ELECTRON_RENDERER_URL: ports.appUrl,
    NODE_ENV: "development",
  };
  delete env.ELECTRON_RUN_AS_NODE;

  let child;
  try {
    child = spawn(executablePath, [`--remote-debugging-port=${debugPort}`, "."], {
      cwd: desktopRoot,
      detached: true,
      env,
      stdio: ["ignore", stdout, stderr],
    });
    closeSync(stdout);
    closeSync(stderr);
    child.unref();

    const running = {
      ...record,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    writeFileSync(sessionFile, `${JSON.stringify(running, null, 2)}\n`, "utf8");
    await waitForDebugger(endpoint, child);
    return running;
  } catch (error) {
    if (child?.pid) await stopProcessTree(child.pid);
    rmSync(sessionFile, { force: true });
    throw error;
  }
}

async function isReusable(record, root) {
  if (
    !record ||
    record.status !== "running" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    !Number.isInteger(record.debugPort) ||
    typeof record.repoRoot !== "string" ||
    resolve(record.repoRoot).toLowerCase() !== root.toLowerCase()
  ) {
    return false;
  }
  try {
    process.kill(record.pid, 0);
    const response = await fetch(`http://127.0.0.1:${record.debugPort}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDebugger(endpoint, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited before CDP became ready with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return;
    } catch {
      // Connection refusal is expected while Electron starts.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error("Electron CDP endpoint did not become ready within 60 seconds");
}

async function stopProcessTree(pid) {
  if (process.platform === "win32") {
    const { spawnSync } = await import("node:child_process");
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The process already exited.
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await startElectron(), null, 2));
}
