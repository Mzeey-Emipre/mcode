import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ensurePlaywright } from "../../.codex/skills/electorn-live-testing/scripts/ensure-playwright.mjs";
import { startElectron } from "../../.codex/skills/electorn-live-testing/scripts/start-electron.mjs";
import { stopElectron } from "../../.codex/skills/electorn-live-testing/scripts/stop-electron.mjs";
import { seedFixtureRepo } from "../agent/fixture-repo.mjs";
import { ensureRuntimeRoot } from "../agent/runtime-contract.mjs";

function readArgument(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

function parseBoundedCount(args, name, fallback, minimum, maximum) {
  const value = Number(readArgument(args, name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

/** Parses the locked packaged Windows comparison inputs. */
export function parsePackagedWindowsArguments(args = process.argv.slice(2)) {
  const gpuType = readArgument(args, "--gpu-type");
  if (gpuType !== "integrated" && gpuType !== "discrete") {
    throw new Error("--gpu-type must be integrated or discrete");
  }
  const adapterName = readArgument(args, "--adapter-name")?.trim();
  if (!adapterName || adapterName.length > 256) {
    throw new Error("--adapter-name must identify one Windows video adapter");
  }
  return {
    adapterName,
    gpuSampleCount: parseBoundedCount(args, "--gpu-sample-count", "30", 5, 300),
    gpuType,
    sampleCount: parseBoundedCount(args, "--sample-count", "7", 3, 20),
  };
}

/** Checks that both packaged acceleration modes completed with the requested state. */
export function validateAccelerationPair(results) {
  const failures = [];
  for (const mode of ["disabled", "default"]) {
    validatePackagedMode(results[mode], mode, failures);
  }
  validatePackagedPairConsistency(results, failures);
  return { passed: failures.length === 0, failures };
}

function validatePackagedMode(result, mode, failures) {
  if (!result) {
    failures.push(`${mode} packaged result is missing`);
    return;
  }
  validatePackagedModeContract(result, mode, failures);
  validatePackagedModeGpuState(result, mode, failures);
  if (!result.correctness?.passed) failures.push(`${mode} packaged correctness checks failed`);
}

function validatePackagedModeContract(result, mode, failures) {
  if (result.accelerationMode !== mode) failures.push(`${mode} packaged result has the wrong acceleration mode`);
  if (result.packaged !== true || result.buildMode !== "production") {
    failures.push(`${mode} result is not a packaged production run`);
  }
  if (result.devToolsOpen !== false) failures.push(`${mode} packaged run did not confirm closed DevTools`);
}

function validatePackagedModeGpuState(result, mode, failures) {
  const expected = mode === "default" ? "enabled" : "disabled_software";
  if (result.gpuFeatureStatus?.gpu_compositing !== expected) {
    failures.push(`${mode} packaged run reported unexpected GPU compositing status`);
  }
}

function validatePackagedPairConsistency(results, failures) {
  if (!results.disabled || !results.default) return;
  validateMatchingSourceRevision(results, failures);
  validateMatchingWorkloadContract(results, failures);
  validateMatchingDeviceIdentity(results, failures);
}

function validateMatchingSourceRevision(results, failures) {
  if (results.disabled.sourceRevision !== results.default.sourceRevision) {
    failures.push("packaged results use different source revisions");
  }
}

function validateMatchingWorkloadContract(results, failures) {
  if (JSON.stringify(results.disabled.comparisonContract) !== JSON.stringify(results.default.comparisonContract)) {
    failures.push("packaged results use different workload contracts");
  }
}

function validateMatchingDeviceIdentity(results, failures) {
  if (
    results.disabled.gpuType !== results.default.gpuType
    || JSON.stringify(results.disabled.deviceIdentity) !== JSON.stringify(results.default.deviceIdentity)
  ) {
    failures.push("packaged results use different device identities");
  }
}

/** Builds the primary frame-cadence comparison for each locked workload. */
export function buildFrameComparison(results) {
  return Object.fromEntries(
    Object.keys(results.disabled.frameResults).map((workload) => [
      workload,
      {
        primaryStatistic: "p95FrameIntervalMs",
        disabled: results.disabled.frameResults[workload].frameIntervals,
        default: results.default.frameResults[workload].frameIntervals,
      },
    ]),
  );
}

function summarizeValues(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const percentile = (quantile) => sorted[Math.ceil(sorted.length * quantile) - 1];
  return {
    sampleCount: sorted.length,
    min: sorted[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
  };
}

/** Summarizes CPU and memory snapshots separately by Electron process type. */
export function buildProcessSummary(result) {
  const processes = Object.values(result.metrics).flatMap((metric) =>
    metric.rawSamples
      .filter((sample) => sample.correctness.passed)
      .flatMap(
        (sample) => sample.attribution.electronProcess?.after.processes ?? [],
      ),
  );
  const types = [...new Set(processes.map((process) => process.type))].sort();
  return Object.fromEntries(
    types.map((type) => {
      const matching = processes.filter((process) => process.type === type);
      return [
        type,
        {
          cpuPercent: summarizeValues(matching.map((process) => process.cpuPercent)),
          workingSetSizeKiB: summarizeValues(
            matching.map((process) => process.memory?.workingSetSizeKiB),
          ),
          privateBytesKiB: summarizeValues(
            matching.map((process) => process.memory?.privateBytesKiB),
          ),
        },
      ];
    }),
  );
}

function resolveOutputFile(repoRoot, args) {
  const outputRoot = resolve(repoRoot, ".dev", "verification", "performance");
  const requested = readArgument(args, "--output");
  const outputFile = requested
    ? resolve(repoRoot, requested)
    : join(outputRoot, "packaged-windows-acceleration.json");
  if (!outputFile.toLowerCase().endsWith(".json")) {
    throw new Error("--output must use the .json extension");
  }
  const outputRelativePath = relative(outputRoot, outputFile);
  if (outputRelativePath.length === 0 || outputRelativePath.startsWith("..")) {
    throw new Error("--output must name a file inside .dev/verification/performance");
  }
  return outputFile;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      rejectCommand(
        new Error(
          `${command} exited with code ${code ?? "none"} and signal ${signal ?? "none"}`,
        ),
      );
    });
  });
}

function resolvePackageRoot(requireFromDesktop, packageName) {
  let current = dirname(requireFromDesktop.resolve(packageName));
  while (!existsSync(join(current, "package.json"))) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not resolve package root for ${packageName}`);
    }
    current = parent;
  }
  return current;
}

async function buildPackagedApp(repoRoot) {
  const desktopRoot = join(repoRoot, "apps", "desktop");
  const desktopRequire = createRequire(join(desktopRoot, "package.json"));
  const desktopPackage = JSON.parse(
    await readFile(join(desktopRoot, "package.json"), "utf8"),
  );
  const buildEnv = {
    ...process.env,
    MCODE_PACKAGING_SOURCE_ROOT: repoRoot,
    MCODE_FRONTEND_PERFORMANCE_MODE: "production",
    VITE_MCODE_PERFORMANCE_MODE: "production",
    VITE_MCODE_SINGLE_INSTANCE: "0",
  };
  await runCommand(process.execPath, ["run", "--cwd", "apps/desktop", "build"], {
    cwd: repoRoot,
    env: buildEnv,
  });
  const stageRoot = join(repoRoot, ".dev", "packaged-performance-app");
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });
  await Promise.all([
    cp(join(desktopRoot, "build"), join(stageRoot, "build"), {
      recursive: true,
      dereference: true,
    }),
    cp(join(desktopRoot, "dist"), join(stageRoot, "dist"), {
      recursive: true,
      dereference: true,
    }),
    cp(join(desktopRoot, "scripts"), join(stageRoot, "scripts"), {
      recursive: true,
      dereference: true,
    }),
  ]);
  const nativeDependencies = ["better-sqlite3", "koffi", "node-pty"];
  for (const dependency of nativeDependencies) {
    const dependencyRoot = dirname(
      desktopRequire.resolve(`${dependency}/package.json`),
    );
    await cp(dependencyRoot, join(stageRoot, "node_modules", dependency), {
      recursive: true,
      dereference: true,
    });
  }
  for (const dependency of [
    "@electron/fuses",
    "esbuild",
    "resedit",
  ]) {
    const dependencyRoot = resolvePackageRoot(desktopRequire, dependency);
    await cp(dependencyRoot, join(stageRoot, "node_modules", ...dependency.split("/")), {
      recursive: true,
      dereference: true,
    });
  }
  const reseditRoot = resolvePackageRoot(desktopRequire, "resedit");
  const reseditRequire = createRequire(join(reseditRoot, "package.json"));
  const peLibraryRoot = resolvePackageRoot(reseditRequire, "pe-library");
  await cp(peLibraryRoot, join(stageRoot, "node_modules", "pe-library"), {
    recursive: true,
    dereference: true,
  });
  const stagedPackage = {
    ...desktopPackage,
    packageManager: "npm@10.9.2",
    scripts: {},
    dependencies: Object.fromEntries(
      nativeDependencies.map((dependency) => [
        dependency,
        desktopPackage.dependencies[dependency],
      ]),
    ),
    devDependencies: {
      electron: desktopPackage.devDependencies.electron,
    },
    build: {
      ...desktopPackage.build,
      npmRebuild: false,
      directories: {
        ...desktopPackage.build.directories,
        output: join(desktopRoot, "release"),
      },
    },
  };
  await writeFile(
    join(stageRoot, "package.json"),
    `${JSON.stringify(stagedPackage, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(stageRoot, "package-lock.json"),
    `${JSON.stringify({
      name: stagedPackage.name,
      version: stagedPackage.version,
      lockfileVersion: 3,
      packages: {},
    }, null, 2)}\n`,
    "utf8",
  );

  const electronBuilderCli = desktopRequire.resolve(
    "electron-builder/out/cli/cli.js",
  );
  await runCommand(
    "node.exe",
    [
      electronBuilderCli,
      "--dir",
      "--win",
      "--x64",
      "--publish",
      "never",
      "--projectDir",
      stageRoot,
    ],
    {
      cwd: stageRoot,
      env: buildEnv,
    },
  );
  const executablePath = join(
    repoRoot,
    "apps",
    "desktop",
    "release",
    "win-unpacked",
    "Mcode.exe",
  );
  if (!existsSync(executablePath)) {
    throw new Error(`Packaged executable is missing: ${executablePath}`);
  }
  return executablePath;
}

async function runPackagedMode(
  repoRoot,
  executablePath,
  electronVersion,
  options,
  accelerationMode,
  outputFile,
) {
  const sessionFileName = `electron-packaged-performance-${accelerationMode}.json`;
  const modeOutputFile = outputFile.replace(/\.json$/i, `.${accelerationMode}.json`);
  const modeOutputRelative = relative(repoRoot, modeOutputFile);
  if (existsSync(join(repoRoot, ".dev", sessionFileName))) {
    stopElectron(repoRoot, { sessionFileName });
  }
  let started = false;
  try {
    await startElectron(repoRoot, {
      accelerationMode,
      packagedExecutablePath: executablePath,
      performanceMode: "production",
      rendererUrl: null,
      sessionFileName,
    });
    started = true;
    await runCommand(
      "node.exe",
      [
        "scripts/perf/packaged-windows-performance-worker.mjs",
        "--sample-count",
        String(options.sampleCount),
        "--gpu-sample-count",
        String(options.gpuSampleCount),
        "--gpu-type",
        options.gpuType,
        "--adapter-name",
        options.adapterName,
        "--acceleration-mode",
        accelerationMode,
        "--electron-version",
        electronVersion,
        "--electron-session-file",
        sessionFileName,
        "--output",
        modeOutputRelative,
      ],
      { cwd: repoRoot },
    );
    return JSON.parse(await readFile(modeOutputFile, "utf8"));
  } finally {
    if (started) stopPackagedElectron(repoRoot, sessionFileName);
  }
}

function stopPackagedElectron(repoRoot, sessionFileName) {
  try {
    stopElectron(repoRoot, { sessionFileName });
  } catch (error) {
    const retry = stopElectron(repoRoot, { sessionFileName });
    if (retry.status !== "already-stopped" && retry.status !== "not-running") throw error;
  }
}

/** Builds Mcode once and runs equal packaged workloads in both acceleration modes. */
export async function runPackagedWindowsAcceleration(
  repoRoot = process.cwd(),
  args = process.argv.slice(2),
) {
  if (process.platform !== "win32") {
    throw new Error("The packaged acceleration comparison requires Windows");
  }
  const root = resolve(repoRoot);
  const options = parsePackagedWindowsArguments(args);
  const outputFile = resolveOutputFile(root, args);
  await mkdir(dirname(outputFile), { recursive: true });
  ensureRuntimeRoot(root);
  seedFixtureRepo(root);
  ensurePlaywright(root);

  const desktopRequire = createRequire(join(root, "apps", "desktop", "package.json"));
  const electronVersion = desktopRequire("electron/package.json").version;
  const executablePath = await buildPackagedApp(root);
  const results = {};
  for (const accelerationMode of ["disabled", "default"]) {
    results[accelerationMode] = await runPackagedMode(
      root,
      executablePath,
      electronVersion,
      options,
      accelerationMode,
      outputFile,
    );
  }
  const correctness = validateAccelerationPair(results);
  const result = {
    schemaVersion: 3,
    recordedAt: new Date().toISOString(),
    gpuType: options.gpuType,
    comparisonContract: results.disabled.comparisonContract,
    frameComparison: buildFrameComparison(results),
    processComparison: {
      disabled: buildProcessSummary(results.disabled),
      default: buildProcessSummary(results.default),
    },
    correctness,
    evidenceStatus:
      results.disabled.gpu.summary.status === "active" &&
      results.default.gpu.summary.status === "active"
        ? "complete"
        : "inconclusive",
    results,
  };
  await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`Packaged Windows acceleration result: ${outputFile}\n`);
  if (!correctness.passed) process.exitCode = 1;
  return result;
}

if (import.meta.main) {
  await runPackagedWindowsAcceleration();
}
