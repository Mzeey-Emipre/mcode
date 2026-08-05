#!/usr/bin/env bun
/** Run the isolated renderer comparison and retain machine-readable evidence. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const verificationDir = join(repoRoot, ".dev", "verification");
const mode = process.argv.includes("--thirty") ? "thirty" : "quick";
const command = process.platform === "win32" ? "bun.exe" : "bun";

if (typeof globalThis.Bun !== "undefined" && process.env.MCODE_PROTO_NODE !== "1") {
  const node = spawn("node", [import.meta.filename, ...process.argv.slice(2)], {
    cwd: repoRoot,
    env: { ...process.env, MCODE_PROTO_NODE: "1" },
    stdio: "inherit",
    shell: false,
  });
  const childCode = await new Promise((resolveProcess) => node.once("exit", (code) => resolveProcess(code ?? 1)));
  process.exitCode = Number(childCode);
  process.exit();
}

async function runCommand(args, stdio = "ignore") {
  await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio, shell: false });
    child.once("error", rejectProcess);
    child.once("exit", (code) => code === 0 ? resolveProcess() : rejectProcess(new Error(`bun ${args.join(" ")} exited with ${code ?? "signal"}`)));
  });
}

async function findPlaywrightModule() {
  const explicit = process.env.MCODE_PLAYWRIGHT_PATH;
  const local = join(repoRoot, "node_modules", "playwright", "index.js");
  if (explicit && existsSync(explicit)) return explicit;
  if (existsSync(local)) return local;
  const runtimeRoot = join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "runtimes", "cua_node");
  if (existsSync(runtimeRoot)) {
    for (const runtime of await (await import("node:fs/promises")).readdir(runtimeRoot)) {
      const candidate = join(runtimeRoot, runtime, "bin", "node_modules", "playwright", "index.js");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findBrowserExecutable() {
  const candidates = process.platform === "win32"
    ? [
        join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function main() {
  let runtimeStarted = false;
  let context;
  let profileDir;
  let route = "";
  let resultsPath = "";
  let summaryPath = "";
  let screenshotPath = "";
  try {
    await runCommand(["run", "--shell", "system", "agent:up"]);
    runtimeStarted = true;
    const ports = JSON.parse(await readFile(join(repoRoot, ".dev", "ports.json"), "utf8"));
    route = `${ports.appUrl.replace(/\/$/, "")}/prototype/renderer-head-to-head?runner=${mode}`;
    resultsPath = join(verificationDir, `renderer-head-to-head-${mode}-results.json`);
    summaryPath = join(verificationDir, `renderer-head-to-head-${mode}.json`);
    screenshotPath = join(verificationDir, `renderer-head-to-head-${mode}.png`);
    const playwrightPath = await findPlaywrightModule();
    const executablePath = findBrowserExecutable();
    if (!playwrightPath || !executablePath) {
      const blocker = { schemaVersion: 1, mode, route, status: "blocked", blocker: "No supported Playwright module and Chromium executable were found." };
      await writeFile(resultsPath, `${JSON.stringify(blocker, null, 2)}\n`, "utf8");
      await writeFile(summaryPath, `${JSON.stringify(blocker, null, 2)}\n`, "utf8");
      console.log(JSON.stringify(blocker));
      return 2;
    }

    profileDir = await mkdtemp(join(repoRoot, ".dev", "renderer-browser-"));
    const imported = await import(pathToFileURL(playwrightPath).href);
    const { chromium } = imported.default ?? imported;
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: true,
      timeout: 10_000,
      viewport: { width: 1440, height: 1200 },
      args: ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu"],
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(route, { waitUntil: "networkidle", timeout: 20_000 });
    await page.locator('[data-testid="run-comparison"]').waitFor({ state: "visible", timeout: 10_000 });
    if (mode === "thirty") await page.locator("#renderer-run-mode").selectOption("thirty");
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="run-comparison"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    }, undefined, { timeout: 20_000 });
    await page.locator('[data-testid="run-comparison"]').click();
    const expectedRuns = mode === "thirty" ? 240 : 8;
    await page.waitForFunction((expected) => {
      const status = document.querySelector('[data-testid="comparison-status"]')?.textContent ?? "";
      return status.includes(`${expected} runs retained`) && status.includes("idle");
    }, expectedRuns, { timeout: mode === "thirty" ? 180_000 : 45_000, polling: 250 });
    const raw = await page.locator('[data-testid="raw-results"]').textContent();
    const report = JSON.parse(raw ?? "{}");
    await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(summaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(JSON.stringify({ schemaVersion: 1, mode, route, resultsPath, summaryPath, screenshotPath, runCount: report.runCount, status: report.gate?.artifactComplete ? "artifact-complete" : "artifact-incomplete", candidatePass: report.gate?.overallCandidatePass === true }));
    return report.gate?.artifactComplete ? 0 : 1;
  } catch (error) {
    const blocker = { schemaVersion: 1, mode, route, status: "blocked", blocker: error instanceof Error ? error.message : String(error) };
    await writeFile(resultsPath, `${JSON.stringify(blocker, null, 2)}\n`, "utf8");
    await writeFile(summaryPath, `${JSON.stringify(blocker, null, 2)}\n`, "utf8");
    if (context) {
      const page = context.pages()[0];
      if (page) await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    }
    console.log(JSON.stringify(blocker));
    return 1;
  } finally {
    await context?.close().catch(() => undefined);
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    if (runtimeStarted) await runCommand(["run", "--shell", "system", "agent:down"]).catch(() => undefined);
  }
}

process.exitCode = await main();
