#!/usr/bin/env node
/**
 * Desktop demo for Branch view default comparison + gating.
 * Launches Electron, seeds one workspace via WS RPC, and screenshots the Branch view.
 */
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const REPO_ROOT = resolve(process.cwd());
const DESKTOP_DIR = join(REPO_ROOT, "apps", "desktop");
const MAIN_BUNDLE = join(DESKTOP_DIR, "dist", "main", "main.cjs");
const SCREENSHOT_DIR = join(REPO_ROOT, "apps", "web", "e2e", "screenshots", "demo-desktop");
const TIMEOUT_MS = Number(process.env.MCODE_DEMO_TIMEOUT_MS ?? 120_000);
const MOD_PRIMARY = process.platform === "darwin" ? "Meta" : "Control";

const require = createRequire(join(REPO_ROOT, "apps", "web", "package.json"));
const { _electron: electron } = require("@playwright/test");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve the launched server's port + auth token from the `server.lock` it
 * writes inside its (isolated) `MCODE_DATA_DIR`.
 *
 * Reading the lock — rather than scanning a port range for any `/health` that
 * answers — guarantees we only ever talk to the instance THIS demo started.
 * A blind scan can attach to another app sharing the range, which once let a
 * demo seed a workspace into the real `~/.mcode` database. We also confirm the
 * lock points at a live server whose `/health` token matches before trusting it.
 *
 * @param {string} dataDir Isolated MCODE_DATA_DIR passed to the launched app.
 * @param {number} [timeoutMs]
 * @returns {Promise<{ port: number, token: string }>}
 */
async function readServerLock(dataDir, timeoutMs = 30_000) {
  const lockPath = join(dataDir, "server.lock");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        if (typeof lock.port === "number" && typeof lock.authToken === "string") {
          const res = await fetch(`http://127.0.0.1:${lock.port}/health`).catch(() => null);
          if (res?.ok) {
            const body = await res.json().catch(() => ({}));
            if (body.authToken === lock.authToken) {
              return { port: lock.port, token: lock.authToken };
            }
          }
        }
      } catch {
        // lock half-written or server still booting; retry
      }
    }
    await sleep(500);
  }
  throw new Error(`No live server.lock under ${dataDir} within ${timeoutMs}ms`);
}

async function rpc(port, token, method, params) {
  return new Promise((resolve, reject) => {
    const id = `demo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC timeout: ${method}`));
    }, 15_000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message ?? `RPC error: ${method}`));
      else resolve(msg.result);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error during ${method}`));
    });
  });
}

async function screenshotStep(page, filename) {
  const path = join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path, fullPage: true });
  console.log(`[demo-desktop-branch] screenshot: ${path}`);
}

async function blurFocusedInput(page) {
  await page
    .evaluate(() => {
      const el = document.activeElement;
      if (el && "blur" in el && typeof el.blur === "function") el.blur();
    })
    .catch(() => {});
}

async function enterWorkspaceComposer(page, workspaceName) {
  const landingRow = page.getByTestId("project-row").filter({ hasText: workspaceName });
  if (await landingRow.first().isVisible().catch(() => false)) {
    await landingRow.first().click({ timeout: 15_000 });
  } else {
    const sidebarRow = page.getByTestId(/^project-row-/).filter({ hasText: workspaceName });
    if (await sidebarRow.first().isVisible().catch(() => false)) {
      await sidebarRow.first().click({ timeout: 15_000 });
    }
  }

  const composer = page.locator('[data-testid="composer"], [data-testid="chat-view"]');
  if (!(await composer.first().isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "New thread" }).click({ timeout: 10_000 });
  }
  await composer.first().waitFor({ state: "visible", timeout: 20_000 });
}

async function openReviewBranchMenu(page, filePrefix) {
  await blurFocusedInput(page);
  await page.locator("body").click({ position: { x: 8, y: 8 } }).catch(() => {});
  await sleep(200);

  await page.keyboard.press(`${MOD_PRIMARY}+d`);
  await sleep(900);

  const switcher = page.getByTestId("review-view-switcher");
  if (!(await switcher.isVisible().catch(() => false))) {
    const reviewCard = page.getByTestId("panel-card-changes");
    if (await reviewCard.isVisible().catch(() => false)) {
      await reviewCard.click();
      await sleep(900);
    } else {
      await page.keyboard.press(`${MOD_PRIMARY}+d`);
      await sleep(900);
    }
  }

  try {
    await switcher.waitFor({ state: "visible", timeout: 20_000 });
  } catch (err) {
    await screenshotStep(page, `${filePrefix}-debug-no-switcher.png`);
    throw err;
  }
  await switcher.click();
  await sleep(200);
}

async function runScenario(scenario) {
  mkdirSync(scenario.dataDir, { recursive: true });
  if (scenario.prepareRepo) scenario.prepareRepo();

  const rendererErrors = [];
  const app = await electron.launch({
    args: ["."],
    cwd: DESKTOP_DIR,
    timeout: TIMEOUT_MS,
    env: {
      ...process.env,
      MCODE_DATA_DIR: scenario.dataDir,
    },
  });

  try {
    const win = await app.firstWindow({ timeout: TIMEOUT_MS });
    win.on("console", (m) => {
      if (m.type() === "error") rendererErrors.push(m.text());
    });
    await win.waitForLoadState("domcontentloaded");
    await win.getByPlaceholder("Search threads...").waitFor({ state: "visible", timeout: 120_000 });

    const { port, token } = await readServerLock(scenario.dataDir);
    console.log(`[demo-desktop-branch] ${scenario.label}: server.lock -> port ${port}`);

    const ws = await rpc(port, token, "workspace.create", {
      name: scenario.workspaceName,
      path: scenario.repoPath.replace(/\\/g, "/"),
    });
    await rpc(port, token, "workspace.touchLastOpened", { id: ws.id });

    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    await win.getByPlaceholder("Search threads...").waitFor({ state: "visible", timeout: 120_000 });
    await sleep(1500);

    await enterWorkspaceComposer(win, scenario.workspaceName);
    await sleep(800);
    await openReviewBranchMenu(win, scenario.filePrefix);

    const branchItem = win.getByTestId("review-view-branch");
    await branchItem.waitFor({ state: "visible", timeout: 10_000 });
    const disabled = await branchItem.getAttribute("aria-disabled");
    console.log(`[demo-desktop-branch] ${scenario.label}: aria-disabled=${disabled ?? "null"}`);

    if (scenario.expectDisabled) {
      if (disabled !== "true") {
        throw new Error(`${scenario.label}: expected Branch view disabled`);
      }
      await screenshotStep(win, `${scenario.filePrefix}-branch-disabled.png`);
      return { pass: true, rendererErrors };
    }

    if (disabled === "true") {
      throw new Error(`${scenario.label}: Branch view unexpectedly disabled`);
    }

    await branchItem.click();
    await sleep(600);
    await win.getByTestId("branch-ref-picker").waitFor({ state: "visible", timeout: 10_000 });
    const targetText = (await win.getByTestId("branch-target-picker").textContent())?.trim() ?? "";
    console.log(`[demo-desktop-branch] ${scenario.label}: comparison target=${targetText}`);
    for (const part of scenario.targetIncludes ?? []) {
      if (!targetText.includes(part)) {
        throw new Error(`${scenario.label}: expected target to include "${part}", got "${targetText}"`);
      }
    }
    await screenshotStep(win, `${scenario.filePrefix}-branch-active.png`);
    return { pass: true, rendererErrors };
  } finally {
    await app.close();
    rmSync(scenario.dataDir, { recursive: true, force: true });
    if (scenario.cleanupRepo) scenario.cleanupRepo();
  }
}

if (!existsSync(MAIN_BUNDLE)) {
  console.error("[demo-desktop-branch] missing desktop build; run `cd apps/desktop && bun run build`");
  process.exit(1);
}

mkdirSync(SCREENSHOT_DIR, { recursive: true });

const automakerPath = process.env.MCODE_DEMO_AUTOMAKER_PATH ?? "C:/src/automaker";
const localOnlyPath = join(tmpdir(), `mcode-branch-local-only-${Date.now()}`);
const localDataDir = join(tmpdir(), `mcode-branch-local-data-${Date.now()}`);
const automakerDataDir = join(tmpdir(), `mcode-branch-automaker-data-${Date.now()}`);

const results = [];

results.push(
  await runScenario({
    label: "automaker with origin",
    filePrefix: "branch-automaker",
    workspaceName: "Automaker Demo",
    repoPath: automakerPath,
    dataDir: automakerDataDir,
    expectDisabled: false,
    targetIncludes: ["origin/"],
  }),
);

results.push(
  await runScenario({
    label: "local-only default branch",
    filePrefix: "branch-local-only",
    workspaceName: "Local Only Demo",
    repoPath: localOnlyPath,
    dataDir: localDataDir,
    expectDisabled: true,
    prepareRepo: () => {
      mkdirSync(localOnlyPath, { recursive: true });
      execSync("git init -b main", { cwd: localOnlyPath, stdio: "ignore" });
      execSync('git config user.email "demo@mcode.local"', { cwd: localOnlyPath, stdio: "ignore" });
      execSync('git config user.name "Mcode Demo"', { cwd: localOnlyPath, stdio: "ignore" });
      execSync('git commit --allow-empty -m "init"', { cwd: localOnlyPath, stdio: "ignore" });
    },
    cleanupRepo: () => rmSync(localOnlyPath, { recursive: true, force: true }),
  }),
);

const allErrors = results.flatMap((r) => r.rendererErrors);
console.log(`[demo-desktop-branch] renderer errors: ${allErrors.length}`);
for (const err of allErrors) console.log(`  - ${err}`);
console.log("[demo-desktop-branch] PASS");
